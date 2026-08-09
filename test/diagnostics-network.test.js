const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  classifyNetworkError,
  probeEndpoint,
  probeProxyTcp,
  createNetworkChecks
} = require('../src/main/core/diagnostics/checks/network');

const TRANSPORT_TIMEOUTS = {
  connectTimeoutMs: 5000,
  connectResponseTimeoutMs: 5000,
  tlsHandshakeTimeoutMs: 5000,
  requestTimeoutMs: 8000
};

test('classifyNetworkError returns stable stage and redacted code', () => {
  const cases = [
    [{ code: 'ENOTFOUND' }, 'dns', false, 'NETWORK_DNS_FAILED'],
    [{ code: 'ECONNREFUSED' }, 'tcp', false, 'NETWORK_TCP_FAILED'],
    [{ code: 'PROXY_CONNECT_RESPONSE_TIMEOUT' }, 'proxy-connect', false, 'NETWORK_TIMEOUT'],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls', false, 'NETWORK_TLS_FAILED'],
    [new Error('Unauthorized: session expired (HTTP 401)'), 'http', true, 'NETWORK_HTTP_REACHED'],
    [new Error('HTTP 503: unavailable'), 'http', true, 'NETWORK_HTTP_REACHED'],
    [new Error('Failed to parse response'), 'http', true, 'NETWORK_HTTP_REACHED']
  ];

  for (const [error, stage, reachedHttp, errorCode] of cases) {
    assert.deepEqual(classifyNetworkError(error), { reachedHttp, stage, errorCode });
  }
});

test('probeEndpoint treats successful and authorization responses as reachable without retaining response data', async () => {
  const success = await probeEndpoint({
    url: 'https://api.example.test/private',
    proxyInput: null,
    timeoutOptions: TRANSPORT_TIMEOUTS,
    httpGet: async () => ({ secret: 'do-not-retain' })
  });
  const httpReachable = [];
  for (const error of [
    new Error('Unauthorized: session expired (HTTP 401)'),
    new Error('Unauthorized: session expired (HTTP 403)'),
    new Error('HTTP 404: not found')
  ]) {
    httpReachable.push(await probeEndpoint({
      url: 'https://api.example.test/private',
      proxyInput: null,
      timeoutOptions: TRANSPORT_TIMEOUTS,
      httpGet: async () => { throw error; }
    }));
  }

  assert.deepEqual(success, {
    status: 'pass',
    summary: 'Endpoint is reachable',
    metadata: { stage: 'http', host: 'api.example.test' }
  });
  assert.deepEqual(httpReachable, [success, success, success]);
  assert.doesNotMatch(JSON.stringify(success), /secret|private/);

  const numericHost = await probeEndpoint({
    url: 'https://203.0.113.7/private',
    httpGet: async () => ({ ok: true })
  });
  assert.deepEqual(numericHost.metadata, { stage: 'http', host: '' });
});

test('probeEndpoint fails HTTP 5xx and maps each transport failure to a stable stage', async () => {
  const cases = [
    [new Error('HTTP 503: unavailable'), 'NETWORK_HTTP_FAILED', 'http'],
    [Object.assign(new Error('dns 10.0.0.1'), { code: 'ENOTFOUND' }), 'NETWORK_DNS_FAILED', 'dns'],
    [Object.assign(new Error('socket refused'), { code: 'ECONNREFUSED' }), 'NETWORK_TCP_FAILED', 'tcp'],
    [Object.assign(new Error('certificate invalid'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'NETWORK_TLS_FAILED', 'tls'],
    [Object.assign(new Error('request timeout'), { code: 'HTTPS_REQUEST_TIMEOUT' }), 'NETWORK_TIMEOUT', 'http']
  ];

  for (const [error, errorCode, stage] of cases) {
    const result = await probeEndpoint({
      url: 'https://api.example.test/secret?token=private',
      httpGet: async () => { throw error; },
      timeoutOptions: TRANSPORT_TIMEOUTS
    });
    assert.deepEqual(result, {
      status: 'fail',
      summary: 'Endpoint reachability check failed',
      errorCode,
      metadata: { stage, host: 'api.example.test' }
    });
    assert.doesNotMatch(JSON.stringify(result), /secret|private|10\.0\.0\.1/);
  }
});

test('probeProxyTcp explicitly connects a normalized IPv6 custom proxy and cleans listeners after connect', async () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  const connects = [];
  const resultPromise = probeProxyTcp({
    proxyUrl: 'http://[2001:db8::1]:8080',
    netConnect: (port, host) => {
      connects.push({ port, host });
      return socket;
    },
    setTimeout: () => ({ id: 0 }),
    clearTimeout: () => {}
  });
  socket.emit('connect');

  assert.deepEqual(await resultPromise, {
    status: 'pass',
    summary: 'Custom proxy TCP connection succeeded',
    metadata: { stage: 'tcp' }
  });
  assert.deepEqual(connects, [{ port: 8080, host: '[2001:db8::1]' }]);
  assert.equal(socket.listenerCount('connect'), 0);
  assert.equal(socket.listenerCount('error'), 0);
  assert.equal(socket.destroyed, true);
});

test('probeProxyTcp rejects invalid custom proxy URLs before opening a socket', async () => {
  for (const proxyUrl of [
    'http://user:password@proxy.example.test:8080',
    'http://proxy.example.test:8080/path',
    'http://proxy.example.test:8080/?q=secret',
    'http://proxy.example.test:8080/#fragment',
    'https://proxy.example.test:8080'
  ]) {
    let connectCalls = 0;
    const result = await probeProxyTcp({
      proxyUrl,
      netConnect: () => { connectCalls += 1; throw new Error('must not connect'); }
    });
    assert.deepEqual(result, {
      status: 'fail',
      summary: 'Custom proxy configuration is invalid',
      errorCode: 'NETWORK_PROXY_CONFIG_INVALID',
      metadata: { stage: 'proxy-config' }
    });
    assert.equal(connectCalls, 0);
    assert.doesNotMatch(JSON.stringify(result), /password|secret|fragment/);
  }
});

test('probeProxyTcp destroys and settles once on connection rejection or timeout', async () => {
  const rejected = new EventEmitter();
  rejected.destroyed = false;
  rejected.destroyCalls = 0;
  rejected.destroy = () => { rejected.destroyed = true; rejected.destroyCalls += 1; };
  rejected.on('error', () => {});
  const rejectedProbe = probeProxyTcp({
    proxyUrl: 'http://proxy.example.test:8080',
    netConnect: () => rejected,
    setTimeout: () => ({ id: 1 }),
    clearTimeout: () => {}
  });
  rejected.emit('error', Object.assign(new Error('refused 127.0.0.1'), { code: 'ECONNREFUSED' }));
  rejected.emit('error', Object.assign(new Error('again'), { code: 'ECONNREFUSED' }));
  assert.deepEqual(await rejectedProbe, {
    status: 'fail',
    summary: 'Custom proxy TCP connection failed',
    errorCode: 'NETWORK_TCP_FAILED',
    metadata: { stage: 'tcp' }
  });
  assert.equal(rejected.destroyCalls, 1);

  const timedOut = new EventEmitter();
  timedOut.destroyed = false;
  timedOut.destroyCalls = 0;
  timedOut.destroy = () => { timedOut.destroyed = true; timedOut.destroyCalls += 1; };
  timedOut.on('error', () => {});
  let onTimeout;
  const timeoutPromise = probeProxyTcp({
    proxyUrl: 'http://proxy.example.test:8080',
    netConnect: () => timedOut,
    setTimeout: (callback) => { onTimeout = callback; return { id: 2 }; },
    clearTimeout: () => {}
  });
  onTimeout();
  timedOut.emit('error', Object.assign(new Error('late error'), { code: 'ECONNREFUSED' }));
  assert.deepEqual(await timeoutPromise, {
    status: 'fail',
    summary: 'Custom proxy TCP connection failed',
    errorCode: 'NETWORK_TIMEOUT',
    metadata: { stage: 'tcp' }
  });
  assert.equal(timedOut.destroyCalls, 1);
});

test('createNetworkChecks normalizes direct, system, and custom proxy modes without Store writes', async () => {
  const writes = [];
  const endpointCalls = [];
  const systemTargets = [];
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  const baseDependencies = {
    httpGet: async (url, headers, proxyInput, timeouts) => {
      endpointCalls.push({ url, headers, proxyInput, timeouts });
      return { ignored: true };
    },
    netConnect: () => socket,
    setTimeout: (callback) => ({ callback }),
    clearTimeout: () => {},
    store: {
      get: () => 'system',
      set: (...args) => writes.push(args)
    },
    resolveElectronSystemProxy: async (targetUrl) => {
      systemTargets.push(targetUrl);
      return 'http://proxy.example.test:8080';
    }
  };
  const checks = createNetworkChecks(baseDependencies);
  assert.deepEqual(checks.map((check) => check.id), [
    'network.proxy-config',
    'network.system-proxy',
    'network.custom-proxy',
    'network.deepseek-api',
    'network.deepseek-platform',
    'network.codex',
    'network.kimi'
  ]);
  assert.equal(checks.find((check) => check.id === 'network.system-proxy').phase, 'remote');
  assert.equal(checks.find((check) => check.id === 'network.deepseek-api').timeoutMs, 8000);
  assert.equal((await checks[0].run()).status, 'pass');
  const systemRun = checks[1].run();
  await Promise.resolve();
  socket.emit('connect');
  assert.equal((await systemRun).status, 'pass');
  assert.equal((await checks[2].run()).status, 'skipped');
  await checks[3].run();
  assert.equal(typeof endpointCalls[0].proxyInput, 'function');
  await endpointCalls[0].proxyInput('https://api.example.test/target');
  assert.deepEqual(systemTargets, ['https://api.deepseek.com/user/balance', 'https://api.example.test/target']);
  assert.deepEqual(endpointCalls[0].headers, {});
  assert.deepEqual(endpointCalls[0].timeouts, TRANSPORT_TIMEOUTS);
  assert.deepEqual(writes, []);

  const customChecks = createNetworkChecks(Object.assign({}, baseDependencies, {
    store: { get: () => 'http://[2001:db8::2]:8080', set: (...args) => writes.push(args) }
  }));
  assert.equal((await customChecks[1].run()).status, 'skipped');
  const customRun = customChecks[2].run();
  socket.emit('connect');
  assert.equal((await customRun).status, 'pass');

  const directChecks = createNetworkChecks(Object.assign({}, baseDependencies, {
    store: { get: () => '', set: (...args) => writes.push(args) }
  }));
  assert.equal((await directChecks[1].run()).status, 'skipped');
  assert.equal((await directChecks[2].run()).status, 'skipped');
  await directChecks[3].run();
  assert.equal(endpointCalls.at(-1).proxyInput, null);
});
