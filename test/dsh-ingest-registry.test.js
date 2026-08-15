const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REGISTRY_KEY, DEFAULT_BATCH_TTL_MS, MAX_REGISTRY_ENTRIES,
  pruneRegistry, classifyBatch
} = require('../src/main/providers/dsh/ingest/registry');

const NOW = Date.UTC(2026, 7, 16, 0, 0, 0);
const INPUT = { sourceId: 'src1', batchId: 'sha256:' + 'a'.repeat(64), rowCount: 2, bodyHash: 'hash-a' };

test('new batch is classified as new and registry gets the entry', () => {
  const r = classifyBatch({}, INPUT, NOW, DEFAULT_BATCH_TTL_MS);
  assert.equal(r.status, 'new');
  assert.equal(r.registry.src1[INPUT.batchId].rowCount, 2);
  assert.equal(r.registry.src1[INPUT.batchId].bodyHash, 'hash-a');
  assert.equal(r.registry.src1[INPUT.batchId].acceptedAt, NOW);
});

test('same key and bodyHash is duplicate; different bodyHash is conflict', () => {
  const first = classifyBatch({}, INPUT, NOW, DEFAULT_BATCH_TTL_MS).registry;
  assert.equal(classifyBatch(first, INPUT, NOW, DEFAULT_BATCH_TTL_MS).status, 'duplicate');
  assert.equal(classifyBatch(first, { ...INPUT, bodyHash: 'hash-b' }, NOW, DEFAULT_BATCH_TTL_MS).status, 'conflict');
});

test('expired entries are pruned before classification', () => {
  const first = classifyBatch({}, INPUT, NOW - DEFAULT_BATCH_TTL_MS - 1, DEFAULT_BATCH_TTL_MS).registry;
  const r = classifyBatch(first, INPUT, NOW, DEFAULT_BATCH_TTL_MS);
  assert.equal(r.status, 'new');
  assert.equal(Object.keys(r.registry.src1).length, 1);
});

test('registry full refuses new batches instead of evicting unexpired entries', () => {
  const registry = { src1: {} };
  for (let i = 0; i < MAX_REGISTRY_ENTRIES; i++) registry.src1['b' + i] = { acceptedAt: NOW, bodyHash: 'h', rowCount: 1 };
  const r = classifyBatch(registry, INPUT, NOW, DEFAULT_BATCH_TTL_MS);
  assert.equal(r.status, 'full');
});
