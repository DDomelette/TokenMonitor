const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IngestError, normalizeBatchEnvelope, mapBatchRows, computeBodyHash
} = require('../src/main/providers/dsh/ingest/validate');

const TS = Date.UTC(2026, 7, 14, 2, 0, 0);
const ROOT = 'root:' + 'a'.repeat(64);
const BATCH = 'sha256:' + 'b'.repeat(64);

function validEnvelope(over = {}) {
  return Object.assign({
    sourceId: 'laptop-1', rootId: ROOT, batchId: BATCH, sentAt: TS,
    rows: [{ v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }]
  }, over);
}

test('accepts a valid ordinary batch', () => {
  const env = normalizeBatchEnvelope(validEnvelope());
  assert.equal(env.sourceId, 'laptop-1');
  assert.equal(env.heartbeat, false);
  assert.equal(env.rows.length, 1);
});

test('rejects invalid sourceId/rootId/batchId with the documented codes', () => {
  for (const [patch, code] of [
    [{ sourceId: 'bad source' }, 'invalid-source-id'],
    [{ rootId: 'nope' }, 'invalid-root-id'],
    [{ batchId: 'nope' }, 'invalid-batch-id']
  ]) {
    assert.throws(() => normalizeBatchEnvelope(validEnvelope(patch)), (e) => e instanceof IngestError && e.status === 400 && e.code === code);
  }
});

test('heartbeat forbids batchId and non-empty rows', () => {
  assert.throws(() => normalizeBatchEnvelope(validEnvelope({ heartbeat: true, batchId: BATCH })), (e) => e.code === 'invalid-heartbeat');
  assert.throws(() => normalizeBatchEnvelope(validEnvelope({ heartbeat: true })), (e) => e.code === 'invalid-heartbeat');
  const env = normalizeBatchEnvelope({ sourceId: 'laptop-1', rootId: ROOT, sentAt: TS, heartbeat: true, rows: [] });
  assert.equal(env.heartbeat, true);
  assert.equal(env.rows.length, 0);
});

test('mapBatchRows rejects the whole batch with invalid-row index', () => {
  const rows = validEnvelope().rows.concat([{ v: 1, time: TS, sessionId: 's2', inputTokens: -1, outputTokens: 1 }]);
  assert.throws(() => mapBatchRows(rows, {}, TS), (e) => e.code === 'invalid-row' && e.index === 1);
});

test('computeBodyHash is stable across key order but differs by row order/content', () => {
  const rows = [{ inputTokens: 1, v: 1, time: TS, sessionId: 's' }];
  assert.equal(computeBodyHash(rows), computeBodyHash([{ v: 1, time: TS, sessionId: 's', inputTokens: 1 }]));
  assert.notEqual(computeBodyHash(rows), computeBodyHash([{ v: 1, time: TS, sessionId: 's', inputTokens: 2 }]));
});
