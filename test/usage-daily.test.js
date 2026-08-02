const test = require('node:test');
const assert = require('node:assert/strict');

const { rollupDaily } = require('../src/main/core/locallog');

// 本地时区日期键(与 localTodayStr 同款逻辑)
function dayKey(iso) {
  return new Date(new Date(iso).getTime() + (-new Date().getTimezoneOffset()) * 60 * 1000).toISOString().slice(0, 10);
}

test('rollupDaily aggregates records across days into provider:date keys', () => {
  const records = [
    { provider: 'codex', ts: new Date('2026-08-01T01:00:00Z').getTime(), usage: { input: 100, cached: 60, output: 10 } },
    { provider: 'codex', ts: new Date('2026-08-01T02:00:00Z').getTime(), usage: { input: 50, cached: 30, output: 5 } },
    { provider: 'kimi', ts: new Date('2026-08-01T03:00:00Z').getTime(), usage: { input: 20, cached: 15, output: 2 } },
    { provider: 'codex', ts: new Date('2026-08-02T01:00:00Z').getTime(), usage: { input: 7, cached: 4, output: 1 } }
  ];
  const daily = rollupDaily(records);
  const d1 = dayKey('2026-08-01T00:00:00Z');
  const d2 = dayKey('2026-08-02T00:00:00Z');

  assert.equal(daily['codex:' + d1].input, 150);
  assert.equal(daily['codex:' + d1].cached, 90);
  assert.equal(daily['codex:' + d1].output, 15);
  assert.equal(daily['codex:' + d1].total, 150 + 15);
  assert.equal(daily['kimi:' + d1].input, 20);
  assert.equal(daily['kimi:' + d1].cached, 15);
  assert.equal(daily['codex:' + d2].input, 7);
  assert.equal(daily['codex:' + d2].total, 7 + 1);
  assert.equal(Object.keys(daily).length, 3);
});

test('rollupDaily tolerates records without total by deriving it', () => {
  const daily = rollupDaily([
    { provider: 'codex', ts: Date.now(), usage: { input: 5, cached: 2, output: 3, total: 8 } }
  ]);
  const key = Object.keys(daily)[0];
  assert.equal(daily[key].total, 8);
});

test('rollupDaily skips empty records list', () => {
  assert.deepEqual(rollupDaily([]), {});
});
