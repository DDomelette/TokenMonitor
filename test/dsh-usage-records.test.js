const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mapRowObjectToRecord,
  parseTelemetryLine,
  rollupDshRecords
} = require('../src/main/providers/dsh/usage-records');

const TS = Date.UTC(2026, 7, 14, 2, 0, 0);

test('mapRowObjectToRecord maps the four buckets into the UsageRecord shape', () => {
  const diagnostics = {};
  const rec = mapRowObjectToRecord({
    v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro',
    inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 100
  }, diagnostics, TS);
  assert.ok(rec);
  assert.equal(rec.ts, TS);
  assert.equal(rec.currency, 'CNY');
  assert.deepEqual(rec.usage, { input: 1100, cached: 3000, output: 2000, total: 6100 });
  assert.ok(rec.cost > 0);
  assert.match(rec.eventFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('mapRowObjectToRecord rejects invalid rows with diagnostics', () => {
  const diagnostics = {};
  assert.equal(mapRowObjectToRecord({ v: 2, time: TS, sessionId: 's', inputTokens: 1, outputTokens: 1 }, diagnostics, TS), null);
  assert.equal(diagnostics.unknownRowVersion, 1);
  assert.equal(mapRowObjectToRecord({ v: 1, time: TS, sessionId: '', inputTokens: 1, outputTokens: 1 }, diagnostics, TS), null);
  assert.equal(diagnostics.invalidSessionId, 1);
});

test('parseTelemetryLine delegates JSON parsing to the shared mapper', () => {
  const rec = parseTelemetryLine(JSON.stringify({
    v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro',
    inputTokens: 5, outputTokens: 6
  }), {}, TS);
  assert.ok(rec);
  assert.deepEqual(rec.usage, { input: 5, cached: 0, output: 6, total: 11 });
});

test('rollupDshRecords rolls daily keys and costs with the dsh prefix', () => {
  const a = mapRowObjectToRecord({ v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, {}, TS);
  const b = mapRowObjectToRecord({ v: 1, time: TS + 3600_000, sessionId: 's2', model: 'deepseek-v4-pro', inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, {}, TS);
  const rolled = rollupDshRecords([a, b], {}, TS);
  assert.deepEqual(rolled.usageDaily['dsh:2026-08-14'], { input: 150, cached: 0, output: 200, total: 350 });
  assert.ok(Number.isFinite(rolled.usageDailyCost['dsh:2026-08-14']) && rolled.usageDailyCost['dsh:2026-08-14'] > 0);
});
