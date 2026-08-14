const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDshDashboard } = require('../src/main/core/dsh-dashboard');

test('buildDshDashboard returns empty lists and zero aggregate for empty input', () => {
  const out = buildDshDashboard({}, {});
  assert.deepEqual(out.tokenDaily, []);
  assert.deepEqual(out.costDaily, []);
  assert.deepEqual(out.aggregate, { token: 0, cost: 0 });
});

test('buildDshDashboard sorts dsh rows by date ascending and sums the aggregate', () => {
  const out = buildDshDashboard(
    {
      'dsh:2026-08-14': { total: 500, input: 100, cached: 300, output: 100 },
      'dsh:2026-08-12': { total: 300 },
      'dsh:2026-08-13': { total: 200 }
    },
    {
      'dsh:2026-08-14': 0.5,
      'dsh:2026-08-12': 0.3,
      'dsh:2026-08-13': 0.2
    }
  );
  assert.deepEqual(out.tokenDaily.map((d) => d.date), ['2026-08-12', '2026-08-13', '2026-08-14']);
  assert.deepEqual(out.tokenDaily.map((d) => d.total), [300, 200, 500]);
  assert.deepEqual(out.costDaily.map((d) => d.date), ['2026-08-12', '2026-08-13', '2026-08-14']);
  assert.deepEqual(out.costDaily.map((d) => d.total), [0.3, 0.2, 0.5]);
  assert.deepEqual(out.aggregate, { token: 1000, cost: 1 });
});

test('buildDshDashboard ignores non-dsh prefixes and malformed date keys', () => {
  const out = buildDshDashboard(
    {
      'deepseek:2026-08-14': { total: 999 },
      'dsh:2026-13-99': { total: 5 },
      'dsh:not-a-date': { total: 5 },
      'dsh:2026-08-10': { total: 7 },
      'garbage': { total: 1 }
    },
    {
      'deepseek:2026-08-14': 9,
      'dsh:2026-13-99': 1,
      'dsh:2026-08-10': 0.1
    }
  );
  assert.deepEqual(out.tokenDaily.map((d) => d.date), ['2026-08-10']);
  assert.deepEqual(out.costDaily.map((d) => d.date), ['2026-08-10']);
  assert.deepEqual(out.aggregate, { token: 7, cost: 0.1 });
});

test('buildDshDashboard drops zero and non-finite totals', () => {
  const out = buildDshDashboard(
    { 'dsh:2026-08-14': { total: 0 }, 'dsh:2026-08-15': { total: 100 } },
    { 'dsh:2026-08-14': 0, 'dsh:2026-08-15': 0.1 }
  );
  assert.deepEqual(out.tokenDaily.map((d) => d.date), ['2026-08-15']);
  assert.deepEqual(out.costDaily.map((d) => d.date), ['2026-08-15']);
});
