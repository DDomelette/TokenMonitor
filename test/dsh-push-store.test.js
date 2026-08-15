const test = require('node:test');
const assert = require('node:assert/strict');
const { commitDshPushRecords } = require('../src/main/providers/dsh/push-store');
const { mapRowObjectToRecord } = require('../src/main/providers/dsh/usage-records');

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

test('commitDshPushRecords writes push aggregates and extraWrites atomically', () => {
  const store = makeStore({ usageDailyPush: {}, usageDailyCostPush: {}, data: { historyDays: 30 } });
  const rec = mapRowObjectToRecord({ v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, {}, TS);
  commitDshPushRecords(store, [rec], {
    diagnostics: {}, nowMs: TS, extraWrites: { 'ingest.dsh.batchRegistry': { src1: { b1: { rowCount: 1, bodyHash: 'x', acceptedAt: TS } } } }
  });
  assert.deepEqual(store.get('usageDailyPush')['dsh:2026-08-14'], { input: 100, cached: 0, output: 200, total: 300 });
  assert.ok(store.get('usageDailyCostPush')['dsh:2026-08-14'] > 0);
  assert.equal(store.get('ingest.dsh.batchRegistry').src1.b1.rowCount, 1);
});

test('commitDshPushRecords uses store snapshot when present', () => {
  // 模拟 electron-store:data 是内部快照,get 从快照读,写 store 属性整体替换快照。
  const data = { usageDailyPush: {}, usageDailyCostPush: {} };
  const store = {
    get(key) { return key.split('.').reduce((v, p) => (v == null ? undefined : v[p]), data); },
    set(key, value) {
      if (typeof key === 'object' && key !== null) { Object.keys(key).forEach((k) => this.set(k, key[k])); return; }
      const parts = key.split('.'); let cur = data;
      while (parts.length > 1) { const p = parts.shift(); if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}; cur = cur[p]; }
      cur[parts[0]] = value;
    }
  };
  Object.defineProperty(store, 'store', {
    get() { return data; },
    set(next) { Object.keys(next).forEach((k) => { delete data[k]; }); Object.assign(data, next); }
  });
  const rec = mapRowObjectToRecord({ v: 1, time: TS, sessionId: 's2', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, {}, TS);
  commitDshPushRecords(store, [rec], { diagnostics: {}, nowMs: TS });
  assert.equal(store.get('usageDailyPush')['dsh:2026-08-14'].total, 2);
});
