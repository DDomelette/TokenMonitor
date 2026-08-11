const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');

const { httpGet } = require('../src/main/core/http');

class TrackedSignal extends EventEmitter {
  constructor(aborted = false) {
    super();
    this.aborted = aborted;
  }
  addEventListener(event, listener) { this.on(event, listener); }
  removeEventListener(event, listener) { this.off(event, listener); }
  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.emit('abort');
  }
}

function withWatchdog(promise, timeoutMs = 300) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('watchdog expired'), { code: 'TEST_WATCHDOG' })), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function installHttpsResponder(t, body) {
  const originalRequest = https.request;
  https.request = (options, onResponse) => {
    const request = new EventEmitter();
    request.destroyed = false;
    request.setTimeout = () => request;
    request.write = () => true;
    request.destroy = () => { request.destroyed = true; };
    request.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        onResponse(response);
        response.emit('data', Buffer.from(JSON.stringify(body)));
        response.emit('end');
      });
    };
    return request;
  };
  t.after(() => { https.request = originalRequest; });
}

function installTlsPassthrough(t) {
  const originalConnect = tls.connect;
  tls.connect = () => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = () => { socket.destroyed = true; };
    queueMicrotask(() => socket.emit('secureConnect'));
    return socket;
  };
  t.after(() => { tls.connect = originalConnect; });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server.address().port;
}

function createConnectProxy(t) {
  const lines = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', (chunk) => {
      lines.push(String(chunk).split('\r\n', 1)[0]);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
  });
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { server, lines };
}

test('shared HTTP client awaits a target-aware resolver before direct requests', async (t) => {
  installHttpsResponder(t, { ok: true });
  const targets = [];

  const result = await httpGet(
    'https://api.example.com/data?x=1',
    {},
    async (targetUrl) => {
      targets.push(targetUrl);
      return null;
    }
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(targets, ['https://api.example.com/data?x=1']);
});

test('shared HTTP client uses a proxy URL returned by an async resolver', async (t) => {
  const proxy = createConnectProxy(t);
  const port = await listen(proxy.server);
  installTlsPassthrough(t);
  installHttpsResponder(t, { ok: true });

  const result = await httpGet(
    'https://api.example.com/data',
    {},
    async () => `http://127.0.0.1:${port}`
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(proxy.lines, ['CONNECT api.example.com:443 HTTP/1.1']);
});

test('proxy resolver failures reject before creating a request', async (t) => {
  let requestCalls = 0;
  const originalRequest = https.request;
  https.request = () => {
    requestCalls += 1;
    throw new Error('request should not start');
  };
  t.after(() => { https.request = originalRequest; });

  await assert.rejects(
    httpGet('https://api.example.com/data', {}, async () => {
      const error = new Error('system proxy unavailable');
      error.code = 'SYSTEM_PROXY_RESOLUTION_FAILED';
      throw error;
    }),
    (error) => error && error.code === 'SYSTEM_PROXY_RESOLUTION_FAILED'
  );
  assert.equal(requestCalls, 0);
});

test('direct HTTP request abort destroys the active request once and removes the abort listener', async (t) => {
  const originalRequest = https.request;
  const signal = new TrackedSignal();
  const request = new EventEmitter();
  request.destroyed = false;
  request.destroyCalls = 0;
  request.setTimeout = () => request;
  request.write = () => true;
  request.end = () => {};
  request.destroy = () => {
    request.destroyCalls += 1;
    request.destroyed = true;
  };
  https.request = () => request;
  t.after(() => { https.request = originalRequest; });

  const pending = httpGet('https://api.example.com/data', {}, null, { signal });
  assert.equal(signal.listenerCount('abort'), 1);
  signal.abort();
  await assert.rejects(
    withWatchdog(pending),
    (error) => error && error.code === 'DIAGNOSTIC_ABORTED'
  );
  assert.equal(request.destroyCalls, 1);
  assert.equal(signal.listenerCount('abort'), 0);
});

test('already-aborted signal opens no HTTP request or proxy socket', async (t) => {
  const originalRequest = https.request;
  const originalConnect = net.connect;
  let requestCalls = 0;
  let connectCalls = 0;
  https.request = () => { requestCalls += 1; throw new Error('must not request'); };
  net.connect = () => { connectCalls += 1; throw new Error('must not connect'); };
  t.after(() => {
    https.request = originalRequest;
    net.connect = originalConnect;
  });
  const signal = new TrackedSignal(true);

  await assert.rejects(
    httpGet('https://api.example.com/data', {}, 'http://proxy.example.com:8080', { signal }),
    (error) => error && error.code === 'DIAGNOSTIC_ABORTED'
  );
  assert.equal(requestCalls, 0);
  assert.equal(connectCalls, 0);
  assert.equal(signal.listenerCount('abort'), 0);
});
