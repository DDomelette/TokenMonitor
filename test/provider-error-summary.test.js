const test = require('node:test');
const assert = require('node:assert/strict');

function loadSummary() {
  const modulePath = require.resolve('../src/main/core/provider-error-summary');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('HTTP summaries omit URL parameters, response bodies, and credentials', () => {
  const { summarizeProviderError } = loadSummary();
  const raw = 'HTTP 503 Service Unavailable https://api.example.com/v1/usage?token=query-secret '
    + '{"access_token":"body-secret","detail":"private response"} Bearer bearer-secret';

  const summary = summarizeProviderError(new Error(raw));

  assert.equal(summary, 'HTTP 503 Service Unavailable');
  assert.doesNotMatch(summary, /query-secret|body-secret|private response|bearer-secret|access_token/i);
});

test('common failures map to stable actionable categories', () => {
  const { summarizeProviderError } = loadSummary();

  assert.equal(summarizeProviderError(new Error('request timeout after 20000ms')), '请求超时');
  assert.equal(
    summarizeProviderError(new Error('proxy connect ECONNREFUSED 127.0.0.1:7890 via http://user:pass@proxy.local')),
    '代理连接失败'
  );
  assert.equal(summarizeProviderError(new Error('getaddrinfo ENOTFOUND api.example.com')), '网络地址无法解析');
  assert.equal(summarizeProviderError(new Error('401 Unauthorized Bearer secret-token')), '认证已过期或无效');
});

test('generic summaries redact tokens, URL queries, filesystem paths, JSON, and remain bounded', () => {
  const { summarizeProviderError } = loadSummary();
  const raw = 'Unexpected provider failure at C:\\Users\\alice\\AppData\\token.json '
    + 'https://example.com/callback?api_key=query-secret '
    + 'sk-abcdefghijklmnopqrstuvwxyz123456 {"token":"body-secret"} '
    + 'x'.repeat(400);

  const summary = summarizeProviderError(new Error(raw));

  assert.ok(summary.length > 0);
  assert.ok(summary.length <= 160);
  assert.doesNotMatch(summary, /alice|AppData|query-secret|abcdefghijklmnopqrstuvwxyz|body-secret|api_key|sk-/i);
  assert.doesNotMatch(summary, /\{.*\}/);
});

test('scheduler stores only safe summaries while retaining raw auth classification internally', async (t) => {
  const { startScheduler } = require('../src/main/core/scheduler');
  let mode = 'http';
  const adapter = {
    id: 'fake',
    displayName: 'Fake',
    capabilities: { balance: false, webUsage: false, quota: true, localLog: false, realtimeProxy: false },
    authStatus() { return 'ok'; },
    async fetchQuota() {
      if (mode === 'http') {
        throw new Error('HTTP 503 Service Unavailable https://api.example.com?token=query-secret {"token":"body-secret"}');
      }
      throw new Error('401 Unauthorized Bearer bearer-secret');
    }
  };
  const registry = {
    list: () => [adapter],
    get: (id) => (id === 'fake' ? adapter : undefined)
  };
  const scheduler = startScheduler({
    registry,
    store: { get() { return null; } },
    broadcast() {},
    intervals: false
  });
  t.after(() => scheduler.stop());

  await scheduler.poll('fake', 'quota');
  let snapshot = scheduler.getSnapshot()[0];
  assert.equal(snapshot.lastError, 'HTTP 503 Service Unavailable');
  assert.doesNotMatch(JSON.stringify(snapshot), /query-secret|body-secret/);

  mode = 'auth';
  await scheduler.poll('fake', 'quota');
  snapshot = scheduler.getSnapshot()[0];
  assert.equal(snapshot.authStatus, 'expired');
  assert.equal(snapshot.lastError, '认证已过期或无效');
  assert.doesNotMatch(JSON.stringify(snapshot), /bearer-secret/);
});
