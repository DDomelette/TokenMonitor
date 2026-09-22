const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHeatmap } = require('../src/main/core/heatmap');

test('all uses official DeepSeek totals without adding or falling back to Harness', () => {
  const data = {
    deepseek: { '2026-09-14': 590000000, '2026-09-15': 0 },
    dsh: { '2026-09-14': 940000000, '2026-09-15': 100, '2026-09-16': 200 },
    codex: { '2026-09-14': 8410740 },
    kimi: { '2026-09-14': 10 }
  };
  const expected = { days: { '2026-09-14': 598410750 }, maxDaily: 598410750 };
  assert.deepEqual(buildHeatmap(data, 'all', 2026), expected);
  assert.deepEqual(buildHeatmap(data, undefined, 2026), expected);
  assert.deepEqual(buildHeatmap(data, 'dsh', 2026).days, data.dsh);
});

test('buildHeatmap sums multiple providers by day for "all"', () => {
  const data = {
    codex: { '2026-08-01': 100, '2026-08-02': 300 },
    kimi: { '2026-08-02': 200 },
    deepseek: { '2026-08-01': 50 }
  };
  const out = buildHeatmap(data, 'all', 2026);
  assert.deepEqual(out.days, { '2026-08-01': 150, '2026-08-02': 500 });
  assert.equal(out.maxDaily, 500);
});

test('buildHeatmap filters by provider and year', () => {
  const data = {
    codex: { '2026-08-01': 100, '2025-12-31': 999 },
    kimi: { '2026-08-01': 50 }
  };
  const out = buildHeatmap(data, 'codex', 2026);
  assert.deepEqual(out.days, { '2026-08-01': 100 });
  assert.equal(out.maxDaily, 100);
});

test('buildHeatmap tolerates missing provider and unknown provider id', () => {
  const data = { codex: { '2026-08-01': 100 } };
  assert.deepEqual(buildHeatmap(data, 'kimi', 2026), { days: {}, maxDaily: 0 });
});

test('buildHeatmap returns only days with data; maxDaily 0 when empty', () => {
  assert.deepEqual(buildHeatmap({}, 'all', 2026), { days: {}, maxDaily: 0 });
  assert.deepEqual(buildHeatmap({ codex: { '2026-01-01': 0 } }, 'codex', 2026), { days: {}, maxDaily: 0 });
});
