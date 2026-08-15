// ingest 业务入口。所有写操作(分类/记账/注册表/source 状态)在同一 commitExclusive 内完成。
const { IngestError, normalizeBatchEnvelope, mapBatchRows, computeBodyHash } = require('./validate');
const { commitDshPushRecords } = require('../push-store');
const {
  REGISTRY_KEY, DEFAULT_BATCH_TTL_MS, classifyBatch, pruneRegistry
} = require('./registry');

const SOURCES_KEY = 'ingest.dsh.sources';

function readStore(store, key) {
  return (store && typeof store.get === 'function') ? store.get(key) : undefined;
}

function setNested(target, key, value) {
  const parts = key.split('.');
  let current = target;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[0]] = value;
}

function normalizeSources(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function markSourceActive(sources, sourceId, rootId, nowMs, hasBatch) {
  const next = JSON.parse(JSON.stringify(sources));
  const prev = next[sourceId] || {};
  next[sourceId] = {
    rootId,
    lastIngestAt: nowMs,
    ...(hasBatch
      ? { ingestStartedAt: prev.ingestStartedAt || nowMs }
      : { ingestStartedAt: prev.ingestStartedAt || null })
  };
  return next;
}

function createIngestApply(options = {}) {
  const store = options.store;
  const commitExclusive = options.commitExclusive || ((fn) => fn());
  const now = options.now || Date.now;
  const onAccepted = options.onAccepted || (() => {});
  const onRejected = options.onRejected || (() => {});

  function commitSources(nextSources) {
    if (!store) return;
    if (typeof store.store === 'object') {
      const copy = JSON.parse(JSON.stringify(store.store));
      setNested(copy, SOURCES_KEY, nextSources);
      store.store = copy;
    } else {
      store.set(SOURCES_KEY, nextSources);
    }
  }

  return {
    async handle(body) {
      const nowMs = now();
      const env = normalizeBatchEnvelope(body);
      const sources = normalizeSources(readStore(store, SOURCES_KEY));
      const nextSources = markSourceActive(sources, env.sourceId, env.rootId, nowMs, !env.heartbeat);

      if (env.heartbeat) {
        await commitExclusive(() => commitSources(nextSources));
        return { ok: true, heartbeat: true };
      }

      const diagnostics = {};
      const records = mapBatchRows(env.rows, diagnostics, nowMs);
      const bodyHash = computeBodyHash(env.rows);

      const outcome = await commitExclusive(async () => {
        const registry = normalizeSources(readStore(store, REGISTRY_KEY));
        const classified = classifyBatch(registry, {
          sourceId: env.sourceId,
          batchId: env.batchId,
          rowCount: records.length,
          bodyHash
        }, nowMs, DEFAULT_BATCH_TTL_MS);

        if (classified.status === 'conflict') {
          onRejected({ sourceId: env.sourceId, code: 'batch-conflict' });
          throw new IngestError(409, 'batch-conflict', 'batchId was already used with different rows');
        }
        if (classified.status === 'full') {
          onRejected({ sourceId: env.sourceId, code: 'registry-full' });
          throw new IngestError(503, 'registry-full', 'batch registry capacity exhausted');
        }
        if (classified.status === 'duplicate') {
          commitSources(markSourceActive(
            normalizeSources(readStore(store, SOURCES_KEY)),
            env.sourceId, env.rootId, nowMs, true
          ));
          return { accepted: 0, duplicates: records.length, changed: false };
        }
        commitDshPushRecords(store, records, {
          diagnostics,
          nowMs,
          extraWrites: {
            [REGISTRY_KEY]: classified.registry,
            [SOURCES_KEY]: nextSources
          }
        });
        return { accepted: records.length, duplicates: 0, changed: true };
      });

      onAccepted({
        sourceId: env.sourceId,
        accepted: outcome.accepted,
        duplicates: outcome.duplicates,
        records,
        changed: outcome.changed
      });
      return { ok: true, accepted: outcome.accepted, duplicates: outcome.duplicates };
    },

    pruneStoredRegistry() {
      if (!store) return;
      const registry = normalizeSources(readStore(store, REGISTRY_KEY));
      const { registry: pruned } = pruneRegistry(registry, now(), DEFAULT_BATCH_TTL_MS);
      if (typeof store.store === 'object') {
        const copy = JSON.parse(JSON.stringify(store.store));
        setNested(copy, REGISTRY_KEY, pruned);
        store.store = copy;
      } else {
        store.set(REGISTRY_KEY, pruned);
      }
    }
  };
}

module.exports = { createIngestApply, SOURCES_KEY };
