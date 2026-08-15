const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PUSH_USAGE_KEY, PUSH_COST_KEY,
  mergeDshKeys, effectiveUsageDaily, effectiveUsageDailyCost, effectiveDshDayTotal
} = require('../src/main/core/dsh-usage-merge');

const local = {
  'dsh:2026-08-14': { input: 100, cached: 0, output: 200, total: 300 },
  'codex:2026-08-14': { input: 5, cached: 0, output: 1, total: 6 }
};
const push = {
  'dsh:2026-08-14': { input: 10, cached: 20, output: 30, total: 60 }
};

test('mergeDshKeys sums dsh rows and keeps other providers untouched', () => {
  assert.deepEqual(mergeDshKeys(local, push)['dsh:2026-08-14'],
    { input: 110, cached: 20, output: 230, total: 360 });
  assert.deepEqual(mergeDshKeys(local, push)['codex:2026-08-14'], local['codex:2026-08-14']);
});

test('effective helpers read merged and filtered store data', () => {
  const store = {
    get(k) {
      if (k === 'usageDaily') return local;
      if (k === 'usageDailyCost') return { 'dsh:2026-08-14': 0.1 };
      if (k === PUSH_USAGE_KEY) return push;
      if (k === PUSH_COST_KEY) return { 'dsh:2026-08-14': 0.2 };
      return undefined;
    }
  };
  assert.equal(effectiveUsageDaily(store, 7, Date.UTC(2026, 7, 14, 4, 0, 0))['dsh:2026-08-14'].total, 360);
  assert.ok(Math.abs(effectiveUsageDailyCost(store, 7, Date.UTC(2026, 7, 14, 4, 0, 0))['dsh:2026-08-14'] - 0.3) < 1e-12);
  assert.equal(effectiveDshDayTotal(store, '2026-08-14'), 360);
});
