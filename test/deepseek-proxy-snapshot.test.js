const test = require('node:test');
const assert = require('node:assert/strict');

const deepseekAdapter = require('../src/main/providers/deepseek');

function usagePayload() {
  const usage = [
    { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '1' },
    { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '2' },
    { type: 'RESPONSE_TOKEN', amount: '3' }
  ];
  return {
    code: 0,
    msg: '',
    data: {
      biz_data: [{
        total: [{ model: 'deepseek-chat', usage }],
        days: []
      }]
    }
  };
}

function makeStore() {
  const values = {
    'providers.deepseek.sessionToken': 'session-token',
    'providers.deepseek.fetchedMonths': [
      '2026-06',
      '2026-05',
      '2026-04',
      '2026-03',
      '2026-02'
    ]
  };
  return {
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; }
  };
}

test('one usage operation snapshots the proxy once and reuses it for historical backfill', async () => {
  const proxyUrl = 'http://127.0.0.1:7890';
  const calls = [];
  let proxyReads = 0;
  const ctx = {
    store: makeStore(),
    getProxyUrl() {
      proxyReads += 1;
      return proxyUrl;
    },
    async httpGet(url, headers, proxy, timeouts) {
      calls.push({ url, headers, proxy, timeouts });
      return usagePayload();
    }
  };

  await deepseekAdapter.fetchUsage(ctx, { month: 8, year: 2026 });

  assert.equal(proxyReads, 1);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://platform.deepseek.com/api/v0/usage/cost?month=8&year=2026',
    'https://platform.deepseek.com/api/v0/usage/amount?month=8&year=2026',
    'https://platform.deepseek.com/api/v0/usage/amount?month=7&year=2026'
  ]);
  assert.ok(calls.every((call) => call.proxy === proxyUrl));
});
