const test = require('node:test');
const assert = require('node:assert/strict');
const { buildToolHandlers } = require('../src/main/mcp/tools');

function makeDeps(overrides) {
  return Object.assign({
    getSnapshot: () => [{
      id: 'kimi', displayName: 'Kimi', capabilities: { quota: true },
      authStatus: 'ok', quota: { billingMode: 'subscription', windows: [] },
      quotaFetchedAt: 42, lastFetchedAt: 41, stale: false
    }],
    getState: () => ({ balance: null }),
    getUsageDaily: () => ({ 'kimi:2026-08-11': { input: 1, cached: 0, output: 2, total: 3 } }),
    now: () => new Date(2026, 7, 11, 12, 0, 0).getTime()
  }, overrides || {});
}

test('list_providers returns projected providers', async () => {
  const h = buildToolHandlers(makeDeps());
  const out = await h.listProviders();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'kimi');
  assert.equal(out[0].quotaFetchedAt, 42);
});

test('get_remaining_usage without provider returns all', async () => {
  const h = buildToolHandlers(makeDeps());
  const out = await h.getRemainingUsage({});
  assert.equal(out.length, 1);
  assert.equal(out[0].billingMode, 'subscription');
});

test('get_usage_summary defaults date to local today from deps.now', async () => {
  const h = buildToolHandlers(makeDeps());
  const out = await h.getUsageSummary({});
  assert.deepEqual(out, [{ id: 'kimi', input: 1, output: 2, cached: 0, total: 3 }]);
});

test('get_model_usage validates date format', async () => {
  const h = buildToolHandlers(makeDeps());
  await assert.rejects(() => h.getModelUsage({ date: '08/11' }), /YYYY-MM-DD/);
  await assert.rejects(() => h.getModelUsage({ provider: 42 }), /provider/);
});

test('readQuotaResource mirrors get_remaining_usage without provider', async () => {
  const h = buildToolHandlers(makeDeps());
  assert.deepEqual(await h.readQuotaResource(), await h.getRemainingUsage({}));
});
