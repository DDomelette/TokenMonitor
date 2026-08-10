const test = require('node:test');
const assert = require('node:assert/strict');
const {
  projectProviders,
  projectRemainingUsage,
  projectModelUsage,
  projectUsageSummary
} = require('../src/main/mcp/projection');

const snapshot = [
  {
    id: 'deepseek', displayName: 'DeepSeek',
    capabilities: { balance: true, webUsage: true, quota: false },
    authStatus: 'ok', quota: null, quotaFetchedAt: null,
    lastFetchedAt: 999, stale: false
  },
  {
    id: 'kimi', displayName: 'Kimi',
    capabilities: { balance: false, webUsage: false, quota: true },
    authStatus: 'expired',
    quota: { planName: 'allegretto', billingMode: 'subscription', windows: [{ kind: 'weekly', name: '本周额度', used: 10, limit: 100, remaining: 90, resetsAt: 1 }] },
    quotaFetchedAt: 1234, lastFetchedAt: 999, stale: true
  }
];
const getState = (id) => (id === 'deepseek'
  ? { balance: { total: 12.5, granted: 2.5, toppedUp: 10, currency: 'CNY' } }
  : { balance: null });

test('projectProviders passes authStatus/stale/quotaFetchedAt through', () => {
  const out = projectProviders(snapshot);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], {
    id: 'kimi', displayName: 'Kimi',
    capabilities: snapshot[1].capabilities,
    authStatus: 'expired', stale: true,
    quotaFetchedAt: 1234, lastFetchedAt: 999
  });
  assert.ok(!('quota' in out[1]), 'quota 明细不属于 list_providers');
});

test('projectRemainingUsage maps balance and windows with quotaFetchedAt', () => {
  const out = projectRemainingUsage(snapshot, getState);
  assert.deepEqual(out[0].balance, { total: 12.5, granted: 2.5, toppedUp: 10, currency: 'CNY' });
  assert.equal(out[0].billingMode, null);
  assert.deepEqual(out[0].windows, []);
  assert.equal(out[1].billingMode, 'subscription');
  assert.equal(out[1].windows.length, 1);
  assert.equal(out[1].quotaFetchedAt, 1234);
  assert.equal(out[1].stale, true);
  const onlyKimi = projectRemainingUsage(snapshot, getState, 'kimi');
  assert.equal(onlyKimi.length, 1);
  assert.equal(onlyKimi[0].id, 'kimi');
});

test('projectModelUsage returns deepseek models and note for others', () => {
  const usageDaily = {
    'deepseek:2026-08-11': { input: 0, cached: 5, output: 0, total: 100, models: [{ model: 'deepseek-v4-pro', tokens: 80 }, { model: 'deepseek-v4-flash', tokens: 20 }] },
    'kimi:2026-08-11': { input: 10, cached: 0, output: 40, total: 50 }
  };
  const out = projectModelUsage(usageDaily, { date: '2026-08-11' });
  const ds = out.find((p) => p.id === 'deepseek');
  assert.deepEqual(ds.models, [{ model: 'deepseek-v4-pro', tokens: 80 }, { model: 'deepseek-v4-flash', tokens: 20 }]);
  const kimi = out.find((p) => p.id === 'kimi');
  assert.deepEqual(kimi.models, []);
  assert.equal(kimi.note, 'provider 无模型级明细');
});

test('projectUsageSummary aggregates per provider for one local day', () => {
  const usageDaily = {
    'deepseek:2026-08-11': { input: 0, cached: 5, output: 0, total: 100 },
    'kimi:2026-08-11': { input: 10, cached: 3, output: 40, total: 50 },
    'kimi:2026-08-10': { input: 1, cached: 0, output: 1, total: 2 }
  };
  const out = projectUsageSummary(usageDaily, { date: '2026-08-11' });
  assert.deepEqual(out.find((p) => p.id === 'kimi'), { id: 'kimi', input: 10, output: 40, cached: 3, total: 50 });
  assert.deepEqual(out.find((p) => p.id === 'deepseek'), { id: 'deepseek', input: 0, output: 0, cached: 5, total: 100 });
  const onlyKimi = projectUsageSummary(usageDaily, { provider: 'kimi', date: '2026-08-10' });
  assert.deepEqual(onlyKimi, [{ id: 'kimi', input: 1, output: 1, cached: 0, total: 2 }]);
});

test('projection output never contains credential keys', () => {
  // 第一层防御:字段白名单映射,quota 上的 apiKey 根本不会被拷进输出
  const poisonedQuota = [{
    id: 'x', displayName: 'X', capabilities: {}, authStatus: 'ok',
    quota: { windows: [], apiKey: 'sk-secret' }, quotaFetchedAt: 1, lastFetchedAt: 1, stale: false
  }];
  const out = projectRemainingUsage(poisonedQuota, () => ({ balance: null }));
  assert.equal(JSON.stringify(out).includes('sk-secret'), false);
  // 第二层防御:透传字段(windows)里混入凭证键时 assertNoSecrets 必须抛错
  const poisonedWindows = [{
    id: 'x', displayName: 'X', capabilities: {}, authStatus: 'ok',
    quota: { windows: [{ kind: 'weekly', apiKey: 'sk-secret' }] }, quotaFetchedAt: 1, lastFetchedAt: 1, stale: false
  }];
  assert.throws(() => projectRemainingUsage(poisonedWindows, () => ({ balance: null })), /凭证|apiKey/i);
});

test('empty inputs produce empty arrays, not errors', () => {
  assert.deepEqual(projectProviders([]), []);
  assert.deepEqual(projectRemainingUsage([], getState), []);
  assert.deepEqual(projectModelUsage({}, { date: '2026-08-11' }), []);
  assert.deepEqual(projectUsageSummary(null, { date: '2026-08-11' }), []);
});
