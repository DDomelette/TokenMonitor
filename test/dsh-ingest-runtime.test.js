const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startIngest } = require('../src/main/providers/dsh/ingest');

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

test('runtime starts with a generated token, reports connection info, and stops', async () => {
  const store = makeStore({});
  const free = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const rt = startIngest({ store, scheduler: null, basePort: free });
  await rt.start();
  assert.equal(rt.isRunning(), true);
  assert.match(rt.getConnectionInfo().url, /\/api\/v1\/dsh\/usage$/);
  await rt.stop();
  assert.equal(rt.isRunning(), false);
});
