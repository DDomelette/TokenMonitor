const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { startIngest } = require('../src/main/providers/dsh/ingest');
const { REGISTRY_KEY } = require('../src/main/providers/dsh/ingest/registry');

function post(port, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/v1/dsh/usage', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

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
const rows = [{
  v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro',
  inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0
}];

test('end-to-end: POST lands in push ledger, retry is idempotent, heartbeat renews lease', async (t) => {
  const store = makeStore({
    usageDaily: { 'dsh:2026-08-13': { input: 1, cached: 0, output: 1, total: 2 } },
    usageDailyCost: {},
    usageDailyPush: {},
    usageDailyCostPush: {},
    'data.historyDays': 30
  });
  const free = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const rt = startIngest({
    store,
    scheduler: {
      runExclusive(id, channel, fn) { return fn(); },
      getSnapshot() { return []; }
    },
    now: () => TS,
    basePort: free
  });
  await rt.start();
  t.after(() => rt.stop());

  const info = rt.getConnectionInfo();
  const first = await post(info.port, info.token, {
    sourceId: 'src-1', rootId: ROOT, batchId: BATCH, sentAt: TS, rows
  });
  assert.deepEqual(first.body, { ok: true, accepted: 1, duplicates: 0 });
  const second = await post(info.port, info.token, {
    sourceId: 'src-1', rootId: ROOT, batchId: BATCH, sentAt: TS, rows
  });
  assert.deepEqual(second.body, { ok: true, accepted: 0, duplicates: 1 });
  assert.equal(store.get('usageDailyPush')['dsh:2026-08-14'].total, 300);
  assert.equal(store.get(REGISTRY_KEY)['src-1'][BATCH].rowCount, 1);

  const hb = await post(info.port, info.token, {
    sourceId: 'src-1', rootId: ROOT, sentAt: TS, heartbeat: true, rows: []
  });
  assert.deepEqual(hb.body, { ok: true, heartbeat: true });
  assert.equal(store.get('ingest.dsh.sources')['src-1'].lastIngestAt, TS);
});

test('end-to-end: invalid batch is rejected without writing ledger or registry', async (t) => {
  const store = makeStore({ usageDailyPush: {}, usageDailyCostPush: {}, 'data.historyDays': 30 });
  const free = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const rt = startIngest({
    store,
    scheduler: {
      runExclusive(id, channel, fn) { return fn(); },
      getSnapshot() { return []; }
    },
    now: () => TS,
    basePort: free
  });
  await rt.start();
  t.after(() => rt.stop());
  const info = rt.getConnectionInfo();
  const res = await post(info.port, info.token, {
    sourceId: 'src-1', rootId: ROOT, batchId: BATCH, sentAt: TS,
    rows: [{ v: 1, time: TS, sessionId: 's1', inputTokens: -1, outputTokens: 1 }]
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid-row');
  assert.deepEqual(store.get('usageDailyPush'), {});
  assert.deepEqual(store.get(REGISTRY_KEY), {});
});
