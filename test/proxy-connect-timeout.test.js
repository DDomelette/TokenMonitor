const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');

const { httpGet } = require('../src/main/core/http');
const { startScheduler } = require('../src/main/core/scheduler');

const FAST_TIMEOUTS = Object.freeze({
  connectTimeoutMs: 25,
  connectResponseTimeoutMs: 40,
  tlsHandshakeTimeoutMs: 40,
  requestTimeoutMs: 100
});

function withWatchdog(promise, timeoutMs = 600) {
  let timer;
  const watchdog = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('test watchdog expired');
      error.code = 'TEST_WATCHDOG';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
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

async function closeServer(server, sockets) {
  sockets.forEach((socket) => socket.destroy());
  await new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate, timeoutMs = 300) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

function trackedServer(t, onConnection) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
    // Consume inbound CONNECT/TLS bytes so peer shutdown is observed promptly.
    socket.resume();
  });
  t.after(async () => closeServer(server, sockets));
  return { server, sockets };
}

function createSilentProxy(t) {
  return trackedServer(t, () => {
    // Accept the TCP connection but never send a CONNECT response.
  });
}

function createStalledTlsProxy(t) {
  return trackedServer(t, (socket) => {
    socket.once('data', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Ignore the following TLS ClientHello so secureConnect never fires.
    });
  });
}

test('TCP connect timeout destroys the socket and rejects exactly once', async (t) => {
  const originalConnect = net.connect;
  const fakeSocket = new EventEmitter();
  fakeSocket.destroyed = false;
  fakeSocket.destroyCalls = 0;
  fakeSocket.write = () => {};
  fakeSocket.destroy = (error) => {
    fakeSocket.destroyCalls += 1;
    fakeSocket.destroyed = true;
    if (error) queueMicrotask(() => fakeSocket.emit('error', error));
  };
  t.after(() => { net.connect = originalConnect; });
  net.connect = () => fakeSocket;

  let rejectionCount = 0;
  const request = httpGet(
    'https://example.com/data',
    {},
    'http://proxy.example.com',
    FAST_TIMEOUTS
  ).catch((error) => {
    rejectionCount += 1;
    throw error;
  });

  await assert.rejects(
    withWatchdog(request),
    (error) => {
      assert.equal(error.code, 'PROXY_TCP_CONNECT_TIMEOUT');
      assert.match(error.message, /Proxy TCP connect timeout/);
      return true;
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(rejectionCount, 1);
  assert.equal(fakeSocket.destroyCalls, 1);
  assert.equal(fakeSocket.destroyed, true);
});

test('silent proxy CONNECT response times out and closes the accepted socket', async (t) => {
  const { server, sockets } = createSilentProxy(t);
  const port = await listen(server);
  let rejectionCount = 0;

  const request = httpGet(
    'https://example.com/data',
    {},
    `http://127.0.0.1:${port}`,
    FAST_TIMEOUTS
  ).catch((error) => {
    rejectionCount += 1;
    throw error;
  });

  await assert.rejects(
    withWatchdog(request),
    (error) => {
      assert.equal(error.code, 'PROXY_CONNECT_RESPONSE_TIMEOUT');
      assert.match(error.message, /Proxy CONNECT response timeout/);
      return true;
    }
  );
  await waitFor(() => sockets.size === 0);

  assert.equal(rejectionCount, 1);
});

test('TLS handshake after a successful CONNECT has its own timeout', async (t) => {
  const { server, sockets } = createStalledTlsProxy(t);
  const port = await listen(server);

  await assert.rejects(
    withWatchdog(httpGet(
      'https://example.com/data',
      {},
      `http://127.0.0.1:${port}`,
      FAST_TIMEOUTS
    )),
    (error) => {
      assert.equal(error.code, 'PROXY_TLS_HANDSHAKE_TIMEOUT');
      assert.match(error.message, /Proxy TLS handshake timeout/);
      return true;
    }
  );
  await waitFor(() => sockets.size === 0);
});

test('scheduler releases inflight after proxy handshake timeout so the channel can retry', async (t) => {
  const { server, sockets } = createSilentProxy(t);
  const port = await listen(server);
  const proxyUrl = `http://127.0.0.1:${port}`;
  let fetchCalls = 0;

  const provider = {
    id: 'silent-proxy',
    displayName: 'Silent proxy',
    capabilities: {
      balance: false,
      webUsage: false,
      quota: true,
      localLog: false
    },
    authStatus: () => 'ok',
    fetchQuota(ctx) {
      fetchCalls += 1;
      return httpGet(
        'https://example.com/quota',
        {},
        ctx.getProxyUrl(),
        FAST_TIMEOUTS
      );
    }
  };
  const registry = {
    list: () => [provider],
    get: (id) => (id === provider.id ? provider : undefined)
  };
  const scheduler = startScheduler({
    registry,
    store: { get: (key) => (key === 'providers.proxyUrl' ? proxyUrl : null) },
    broadcast: () => {},
    intervals: false
  });
  t.after(() => scheduler.stop());

  await withWatchdog(scheduler.poll(provider.id, 'quota'));
  await withWatchdog(scheduler.poll(provider.id, 'quota'));
  await waitFor(() => sockets.size === 0);

  assert.equal(fetchCalls, 2);
  assert.equal(scheduler.getState(provider.id).lastError, '请求超时');
});
