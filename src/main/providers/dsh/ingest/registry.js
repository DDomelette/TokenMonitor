// (sourceId, batchId) 幂等注册表。持久化在 store 键 ingest.dsh.batchRegistry。
// 容量满时只淘汰过期项;没有过期项可淘汰就拒绝新 batch(registry-full)。
const REGISTRY_KEY = 'ingest.dsh.batchRegistry';
const DEFAULT_BATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REGISTRY_ENTRIES = 200000;

function countEntries(registry) {
  let n = 0;
  Object.keys(registry || {}).forEach((sourceId) => { n += Object.keys(registry[sourceId] || {}).length; });
  return n;
}

function pruneRegistry(registry, nowMs, ttlMs = DEFAULT_BATCH_TTL_MS) {
  const out = {};
  let pruned = 0;
  Object.keys(registry || {}).forEach((sourceId) => {
    const source = registry[sourceId] || {};
    Object.keys(source).forEach((batchId) => {
      const entry = source[batchId] || {};
      if (!Number.isFinite(Number(entry.acceptedAt)) || nowMs - Number(entry.acceptedAt) > ttlMs) {
        pruned++;
        return;
      }
      out[sourceId] = out[sourceId] || {};
      out[sourceId][batchId] = entry;
    });
  });
  return { registry: out, pruned };
}

function classifyBatch(registry, input, nowMs, ttlMs = DEFAULT_BATCH_TTL_MS) {
  const { registry: next, pruned } = pruneRegistry(registry, nowMs, ttlMs);
  const source = next[input.sourceId] || {};
  const existing = source[input.batchId];
  if (existing) {
    return existing.bodyHash === input.bodyHash
      ? { status: 'duplicate', registry: next, existing }
      : { status: 'conflict', registry: next, existing };
  }
  if (countEntries(next) >= MAX_REGISTRY_ENTRIES) return { status: 'full', registry: next };
  next[input.sourceId] = Object.assign({}, source, {
    [input.batchId]: {
      rowCount: input.rowCount,
      bodyHash: input.bodyHash,
      acceptedAt: nowMs
    }
  });
  return { status: 'new', registry: next };
}

module.exports = {
  REGISTRY_KEY, DEFAULT_BATCH_TTL_MS, MAX_REGISTRY_ENTRIES,
  pruneRegistry, classifyBatch
};
