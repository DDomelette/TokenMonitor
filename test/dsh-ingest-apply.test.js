const test = require('node:test');
const assert = require('node:assert/strict');
const { createIngestApply, SOURCES_KEY } = require('../src/main/providers/dsh/ingest/apply');
const { REGISTRY_KEY } = require('../src/main/providers/dsh/ingest/registry');

function makeStore(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  return {
    get(key) { return key.split('.').reduce((v, p) => (v == null ? undefined : v[p]), data); },
    set(key, value) {
      if (typeof key === 'object' && key !== null) { Object.keys(key).forEach((k) => this.set(k, key[k])); return; }
      const parts = key.split('.'); let cur = data;
      while (parts.length > 1) { const p = parts.shift(); if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}; cur = cur[p]; }
      cur[parts[0]] = value;
    }
  };
}
const TS = Date.UTC(2026, 7, 14, 2, 0, 0);
const ROOT = 'root:' + 'a'.repeat(64);
const BATCH = 'sha256:' + 'b'.repeat(64);
function envelope(over = {}) {
  return Object.assign({
    sourceId: 'src-1', rootId: ROOT, batchId: BATCH, sentAt: TS,
    rows: [{ v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }]
  }, over);
}

test('new batch commits push ledger, registry and source state once', async () => {
  const store = makeStore({ usageDailyPush: {}, usageDailyCostPush: {}, 'data.historyDays': 30 });
  const accepted = [];
  const apply = createIngestApply({ store, now: () => TS, onAccepted: (r) => accepted.push(r) });
  const result = await apply.handle(envelope());
  assert.deepEqual(result, { ok: true, accepted: 1, duplicates: 0 });
  assert.equal(store.get('usageDailyPush')['dsh:2026-08-14'].total, 300);
  assert.equal(store.get(REGISTRY_KEY)['src-1'][BATCH].rowCount, 1);
  assert.equal(store.get(SOURCES_KEY)['src-1'].rootId, ROOT);
  assert.equal(accepted.length, 1);
});

test('retry with the same batch is idempotent and does not double count', async () => {
  const store = makeStore({ usageDailyPush: {}, usageDailyCostPush: {}, 'data.historyDays': 30 });
  const apply = createIngestApply({ store, now: () => TS });
  await apply.handle(envelope());
  const second = await apply.handle(envelope());
  assert.deepEqual(second, { ok: true, accepted: 0, duplicates: 1 });
  assert.equal(store.get('usageDailyPush')['dsh:2026-08-14'].total, 300);
});

test('same key with different rows is a 409 conflict', async () => {
  const store = makeStore({ usageDailyPush: {}, usageDailyCostPush: {}, 'data.historyDays': 30 });
  const apply = createIngestApply({ store, now: () => TS });
  await apply.handle(envelope());
  await assert.rejects(apply.handle(envelope({
    rows: [{ v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }]
  })), (e) => e.status === 409 && e.code === 'batch-conflict');
});

test('heartbeat updates source lease without touching ledger or registry', async () => {
  const store = makeStore({});
  const apply = createIngestApply({ store, now: () => TS });
  const result = await apply.handle({ sourceId: 'src-1', rootId: ROOT, sentAt: TS, heartbeat: true, rows: [] });
  assert.deepEqual(result, { ok: true, heartbeat: true });
  assert.equal(store.get(SOURCES_KEY)['src-1'].lastIngestAt, TS);
  assert.equal(store.get('usageDailyPush'), undefined);
  assert.equal(store.get(REGISTRY_KEY), undefined);
});

test('configured batchTtlDays drives classification instead of the fixed default', async () => {
  const store = makeStore({
    usageDailyPush: {},
    usageDailyCostPush: {},
    data: { historyDays: 30 },
    ingest: { dsh: { batchTtlDays: 1 } }
  });
  let current = TS;
  const apply = createIngestApply({ store, now: () => current });
  await apply.handle(envelope());

  current = TS + 2 * 24 * 60 * 60 * 1000;
  const later = await apply.handle(envelope({
    rows: [{ v: 1, time: current, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }]
  }));
  assert.deepEqual(later, { ok: true, accepted: 1, duplicates: 0 });
  assert.equal(store.get('usageDailyPush')['dsh:2026-08-16'].total, 300);
});

test('pruneStoredRegistry uses the configured batchTtlDays', () => {
  const old = TS - 2 * 24 * 60 * 60 * 1000;
  const store = makeStore({
    ingest: {
      dsh: {
        batchTtlDays: 1,
        batchRegistry: {
          src: { b: { acceptedAt: old, rowCount: 1, bodyHash: 'h' } }
        }
      }
    }
  });
  const apply = createIngestApply({ store, now: () => TS });
  apply.pruneStoredRegistry();
  assert.deepEqual(store.get(REGISTRY_KEY), {});
});
