const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');

const { httpGet } = require('../src/main/core/http');

const TEST_TIMEOUTS = Object.freeze({
  connectTimeoutMs: 500,
  connectResponseTimeoutMs: 500,
  tlsHandshakeTimeoutMs: 500,
  requestTimeoutMs: 500
});

function withWatchdog(promise, timeoutMs = 1000) {
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

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

function installTransportHarness(t) {
  const originalNetConnect = net.connect;
  const originalTlsConnect = tls.connect;
  const originalHttpsRequest = https.request;

  const rawSocket = new EventEmitter();
  rawSocket.destroyed = false;
  rawSocket.destroyCalls = 0;
  rawSocket.pauseCalls = 0;
  rawSocket.unshiftCalls = [];
  rawSocket.writes = [];
  rawSocket.write = (chunk) => {
    rawSocket.writes.push(String(chunk));
    return true;
  };
  rawSocket.pause = () => {
    rawSocket.pauseCalls += 1;
    return rawSocket;
  };
  rawSocket.unshift = (chunk) => {
    rawSocket.unshiftCalls.push(Buffer.from(chunk));
    return true;
  };
  rawSocket.destroy = () => {
    rawSocket.destroyCalls += 1;
    rawSocket.destroyed = true;
  };

  let tlsConnectCalls = 0;
  const tlsStartSnapshots = [];

  net.connect = () => rawSocket;
  tls.connect = (options) => {
    tlsConnectCalls += 1;
    tlsStartSnapshots.push({
      socket: options.socket,
      pauseCalls: rawSocket.pauseCalls,
      unshiftCalls: rawSocket.unshiftCalls.map((chunk) => Buffer.from(chunk))
    });

    const tlsSocket = new EventEmitter();
    tlsSocket.destroyed = false;
    tlsSocket.destroy = () => { tlsSocket.destroyed = true; };
    queueMicrotask(() => tlsSocket.emit('secureConnect'));
    return tlsSocket;
  };

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
        response.emit('data', Buffer.from('{"ok":true}'));
        response.emit('end');
      });
    };
    return request;
  };

  t.after(() => {
    net.connect = originalNetConnect;
    tls.connect = originalTlsConnect;
    https.request = originalHttpsRequest;
  });

  return {
    rawSocket,
    get tlsConnectCalls() { return tlsConnectCalls; },
    tlsStartSnapshots
  };
}

test('fragmented CONNECT status line and header do not start TLS before the complete header', async (t) => {
  const harness = installTransportHarness(t);
  let settled = false;

  const request = httpGet(
    'https://example.com/data',
    {},
    'http://proxy.example.com:8080',
    TEST_TIMEOUTS
  );
  request.then(
    () => { settled = true; },
    () => { settled = true; }
  );

  harness.rawSocket.emit('connect');
  harness.rawSocket.emit('data', Buffer.from('HTTP/1.'));
  await flushEvents();
  assert.equal(settled, false);
  assert.equal(harness.tlsConnectCalls, 0);

  harness.rawSocket.emit(
    'data',
    Buffer.from('1 200 Connection Established\r\nProxy-Agent: fixture\r\n')
  );
  await flushEvents();
  assert.equal(settled, false);
  assert.equal(harness.tlsConnectCalls, 0);

  harness.rawSocket.emit('data', Buffer.from('\r\n'));

  assert.deepEqual(await withWatchdog(request), { ok: true });
  assert.equal(harness.tlsConnectCalls, 1);
  assert.equal(harness.rawSocket.destroyCalls, 0);
});

test('bytes following the CONNECT header are unshifted before TLS starts', async (t) => {
  const harness = installTransportHarness(t);
  const tunnelBytes = Buffer.from([0x16, 0x03, 0x03, 0x00, 0x01]);
  const request = httpGet(
    'https://example.com/data',
    {},
    'http://proxy.example.com:8080',
    TEST_TIMEOUTS
  );

  harness.rawSocket.emit('connect');
  harness.rawSocket.emit(
    'data',
    Buffer.concat([
      Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'),
      tunnelBytes
    ])
  );

  assert.deepEqual(await withWatchdog(request), { ok: true });
  assert.equal(harness.tlsConnectCalls, 1);
  assert.equal(harness.tlsStartSnapshots[0].socket, harness.rawSocket);
  assert.equal(harness.tlsStartSnapshots[0].pauseCalls, 1);
  assert.equal(harness.tlsStartSnapshots[0].unshiftCalls.length, 1);
  assert.deepEqual(harness.tlsStartSnapshots[0].unshiftCalls[0], tunnelBytes);
});

test('fragmented non-200 CONNECT response rejects only after the full header arrives', async (t) => {
  const harness = installTransportHarness(t);
  let settled = false;

  const request = httpGet(
    'https://example.com/data',
    {},
    'http://proxy.example.com:8080',
    TEST_TIMEOUTS
  );
  request.then(
    () => { settled = true; },
    () => { settled = true; }
  );

  harness.rawSocket.emit('connect');
  harness.rawSocket.emit('data', Buffer.from('HTTP/1.1 4'));
  await flushEvents();
  assert.equal(settled, false);

  harness.rawSocket.emit(
    'data',
    Buffer.from('07 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n')
  );
  await flushEvents();
  assert.equal(settled, false);

  harness.rawSocket.emit('data', Buffer.from('\r\n'));

  await assert.rejects(
    withWatchdog(request),
    (error) => {
      assert.match(error.message, /proxy CONNECT failed: HTTP\/1\.1 407/);
      assert.doesNotMatch(error.message, /Proxy-Authenticate/);
      return true;
    }
  );
  assert.equal(harness.tlsConnectCalls, 0);
  assert.equal(harness.rawSocket.destroyCalls, 1);
});

test('CONNECT response headers larger than 32 KiB fail closed without starting TLS', async (t) => {
  const harness = installTransportHarness(t);
  const request = httpGet(
    'https://example.com/data',
    {},
    'http://proxy.example.com:8080',
    TEST_TIMEOUTS
  );

  harness.rawSocket.emit('connect');
  harness.rawSocket.emit(
    'data',
    Buffer.concat([
      Buffer.from('HTTP/1.1 200 Connection Established\r\nX-Oversized: '),
      Buffer.alloc(32 * 1024, 0x61)
    ])
  );

  await assert.rejects(
    withWatchdog(request),
    (error) => {
      assert.equal(error.code, 'PROXY_CONNECT_HEADER_TOO_LARGE');
      assert.match(error.message, /Proxy CONNECT response header too large/);
      return true;
    }
  );
  assert.equal(harness.tlsConnectCalls, 0);
  assert.equal(harness.rawSocket.destroyCalls, 1);
});
