const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const { httpGet } = require('../src/main/core/http');
const { fetchBalance } = require('../src/main/providers/deepseek/balance');
const { UsageFetcher, localTodayStr } = require('../src/main/providers/deepseek/usage');
const deepseekAdapter = require('../src/main/providers/deepseek');

function usageList(hit = 1, miss = 2, response = 3) {
  return [
    { type: 'PROMPT_TOKEN', amount: '0' },
    { type: 'PROMPT_CACHE_HIT_TOKEN', amount: String(hit) },
    { type: 'PROMPT_CACHE_MISS_TOKEN', amount: String(miss) },
    { type: 'RESPONSE_TOKEN', amount: String(response) },
    { type: 'REQUEST', amount: '0' }
  ];
}

function usagePayload() {
  const usage = usageList();
  return {
    code: 0,
    msg: '',
    data: {
      biz_data: [{
        total: [{ model: 'deepseek-chat', usage }],
        days: [{
          date: localTodayStr(),
          data: [{ model: 'deepseek-chat', usage }]
        }]
      }]
    }
  };
}

function balancePayload() {
  return {
    is_available: true,
    balance_infos: [{
      currency: 'USD',
      total_balance: '10.00',
      granted_balance: '2.00',
      topped_up_balance: '8.00'
    }]
  };
}

function installHttpsResponder(t, responder) {
  const originalRequest = https.request;
  https.request = (options, onResponse) => {
    const request = new EventEmitter();
    request.destroyed = false;
    request.setTimeout = () => request;
    request.write = () => true;
    request.destroy = () => { request.destroyed = true; };
    request.end = () => {
      queueMicrotask(() => {
        const responseSpec = responder(options);
        const response = new EventEmitter();
        response.statusCode = responseSpec.statusCode === undefined
          ? 200
          : responseSpec.statusCode;
        onResponse(response);
        response.emit('data', Buffer.from(responseSpec.body));
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
  const connectLines = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', (chunk) => {
      connectLines.push(String(chunk).split('\r\n', 1)[0]);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
  });
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => server.close(() => resolve()));
  });
  return { server, connectLines };
}

function makeStore(initial) {
  const values = Object.assign({}, initial);
  return {
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; },
    values
  };
}

test('DeepSeek adapter passes the live proxy and shared transport to every network path', async (t) => {
  const proxyUrl = 'http://127.0.0.1:7890';
  const calls = [];
  const fetchedMonths = ['2026-07', '2026-06', '2026-05', '2026-04', '2026-03', '2026-02'];
  const store = makeStore({
    'providers.deepseek.apiKey': 'api-key',
    'providers.deepseek.sessionToken': 'session-token',
    'providers.deepseek.fetchedMonths': fetchedMonths
  });
  const fakeHttpGet = async (url, headers, proxy, timeouts) => {
    calls.push({ url, headers, proxy, timeouts });
    return url.includes('/user/balance') ? balancePayload() : usagePayload();
  };

  installHttpsResponder(t, (options) => ({
    statusCode: 200,
    body: JSON.stringify(
      options.hostname === 'api.deepseek.com' ? balancePayload() : usagePayload()
    )
  }));

  const ctx = {
    store,
    httpGet: fakeHttpGet,
    getProxyUrl: () => proxyUrl,
    logger: { log() {}, error() {} }
  };

  const balance = await deepseekAdapter.fetchBalance(ctx);
  const usage = await deepseekAdapter.fetchUsage(ctx, { month: 8, year: 2026 });

  assert.equal(balance.currency, 'USD');
  assert.equal(usage.amount.aggregate.todayTokens, 6);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.deepseek.com/user/balance',
    'https://platform.deepseek.com/api/v0/usage/cost?month=8&year=2026',
    'https://platform.deepseek.com/api/v0/usage/amount?month=8&year=2026'
  ]);
  assert.ok(calls.every((call) => call.proxy === proxyUrl));
  assert.equal(calls[0].timeouts.requestTimeoutMs, 10000);
  assert.equal(calls[1].timeouts.requestTimeoutMs, 15000);
  assert.equal(calls[2].timeouts.requestTimeoutMs, 15000);
  assert.equal(calls[0].headers.Authorization, 'Bearer api-key');
  assert.equal(calls[1].headers.Authorization, 'Bearer session-token');
});

test('DeepSeek balance reaches api.deepseek.com through a local CONNECT proxy', async (t) => {
  const proxy = createConnectProxy(t);
  const port = await listen(proxy.server);
  installTlsPassthrough(t);
  installHttpsResponder(t, () => ({
    statusCode: 200,
    body: JSON.stringify(balancePayload())
  }));

  const result = await fetchBalance('api-key', {
    httpGet,
    proxyUrl: `http://127.0.0.1:${port}`
  });

  assert.equal(result.total, '10.00');
  assert.deepEqual(proxy.connectLines, ['CONNECT api.deepseek.com:443 HTTP/1.1']);
});

test('DeepSeek usage reaches platform.deepseek.com through a local CONNECT proxy', async (t) => {
  const proxy = createConnectProxy(t);
  const port = await listen(proxy.server);
  installTlsPassthrough(t);
  installHttpsResponder(t, () => ({
    statusCode: 200,
    body: JSON.stringify(usagePayload())
  }));

  const result = await new UsageFetcher().fetchUsageAmount(
    'session-token',
    8,
    2026,
    { httpGet, proxyUrl: `http://127.0.0.1:${port}` }
  );

  assert.equal(result.aggregate.todayTokens, 6);
  assert.deepEqual(proxy.connectLines, ['CONNECT platform.deepseek.com:443 HTTP/1.1']);
});

test('empty proxy values remain direct while preserving injected transport and timeouts', async (t) => {
  const calls = [];
  const fakeHttpGet = async (url, headers, proxy, timeouts) => {
    calls.push({ url, headers, proxy, timeouts });
    return url.includes('/user/balance') ? balancePayload() : usagePayload();
  };
  installHttpsResponder(t, (options) => ({
    statusCode: 200,
    body: JSON.stringify(
      options.hostname === 'api.deepseek.com' ? balancePayload() : usagePayload()
    )
  }));

  await fetchBalance('api-key', { httpGet: fakeHttpGet, proxyUrl: '' });
  await new UsageFetcher().fetchUsageCost(
    'session-token',
    8,
    2026,
    { httpGet: fakeHttpGet, proxyUrl: '' }
  );

  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.proxy === null));
  assert.deepEqual(calls.map((call) => call.timeouts.requestTimeoutMs), [10000, 15000]);
});

test('non-2xx usage responses reject immediately and never trigger month fallback', async (t) => {
  const requestedPaths = [];
  installHttpsResponder(t, (options) => {
    requestedPaths.push(options.path);
    return { statusCode: 500, body: '{"message":"internal error"}' };
  });

  await assert.rejects(
    new UsageFetcher().fetchUsageWithFallback('session-token', 8, 2026),
    /HTTP 500/
  );
  assert.deepEqual(requestedPaths, ['/api/v0/usage/cost?month=8&year=2026']);
});

test('401 and 403 remain recognizable authentication failures', async (t) => {
  let statusCode = 401;
  installHttpsResponder(t, () => ({ statusCode, body: '{}' }));

  await assert.rejects(fetchBalance('api-key'), /Unauthorized:.*HTTP 401/);
  statusCode = 403;
  await assert.rejects(
    new UsageFetcher().fetchUsageAmount('session-token', 8, 2026),
    /Unauthorized:.*HTTP 403/
  );
});

test('DeepSeek modules delegate network ownership to the shared client', () => {
  const balanceSource = fs.readFileSync(
    path.resolve(__dirname, '../src/main/providers/deepseek/balance.js'),
    'utf8'
  );
  const usageSource = fs.readFileSync(
    path.resolve(__dirname, '../src/main/providers/deepseek/usage.js'),
    'utf8'
  );
  const adapterSource = fs.readFileSync(
    path.resolve(__dirname, '../src/main/providers/deepseek/index.js'),
    'utf8'
  );

  assert.doesNotMatch(balanceSource, /require\(['"]https['"]\)/);
  assert.doesNotMatch(usageSource, /require\(['"]https['"]\)/);
  assert.match(adapterSource, /httpGet:\s*ctx\.httpGet/);
  assert.match(adapterSource, /proxyUrl:\s*ctx\.getProxyUrl\(\)/);
  assert.match(adapterSource, /fetchBalance\(apiKey,\s*requestOptionsFor\(ctx\)\)/);
  assert.match(adapterSource, /const requestOptions = requestOptionsFor\(ctx\);/);
  assert.match(adapterSource, /fetchUsageWithFallback\([\s\S]*?\brequestOptions\s*\)/);
  assert.match(adapterSource, /backfillMonths\([\s\S]*?\brequestOptions\s*\)/);
  assert.match(adapterSource, /fetchUsageAmount\(token,\s*m,\s*y,\s*requestOptions\)/);
});
