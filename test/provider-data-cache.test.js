const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueryCache } = require('../renderer/src/lib/query-cache.js');
const { createProviderData } = require('../renderer/src/provider-data.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('ten dashboard subscribers share one request and one cached result', async () => {
  const response = deferred();
  let calls = 0;
  const cache = createQueryCache(() => { calls++; return response.promise; });
  let notified = 0;
  assert.equal(cache.read('deepseek'), null);
  assert.equal(calls, 0, 'reading a React snapshot must not start IO');
  const stops = Array.from({ length: 10 }, () => cache.subscribe('deepseek', () => notified++));
  await flush();
  assert.equal(calls, 1);
  response.resolve({ balance: 12 });
  await flush();
  assert.equal(notified, 10);
  assert.deepEqual(cache.read('deepseek'), { balance: 12 });
  stops.forEach((stop) => stop());
  const stop = cache.subscribe('deepseek', () => {});
  await flush();
  assert.equal(calls, 1);
  stop();
});

test('changes during an inflight request discard its old reply and coalesce the follow-up', async () => {
  const requests = [];
  const cache = createQueryCache(() => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  const received = [];
  const stop = cache.subscribe('deepseek', () => received.push(cache.read('deepseek')));
  await flush();
  cache.invalidate();
  cache.invalidate();
  requests[0].resolve({ version: 1 });
  await flush();
  assert.equal(requests.length, 2);
  assert.deepEqual(received, [], 'invalidated response must never flash on screen');
  requests[1].resolve({ version: 2 });
  await flush();
  assert.deepEqual(received, [{ version: 2 }]);
  stop();
});

test('hidden queries stay idle until resubscribed and failed refreshes keep the last good data', async () => {
  let calls = 0;
  let fail = false;
  const cache = createQueryCache(async () => {
    calls++;
    if (fail) throw new Error('unavailable');
    return calls;
  });
  const stop = cache.subscribe('key', () => {});
  await flush();
  stop();
  cache.invalidate();
  await flush();
  assert.equal(calls, 1);
  fail = true;
  const stopAgain = cache.subscribe('key', () => {});
  await flush();
  assert.equal(calls, 2);
  assert.equal(cache.read('key'), 1);
  fail = false;
  cache.invalidate();
  await flush();
  assert.equal(cache.read('key'), 3);
  stopAgain();
});

function makeData() {
  let broadcast;
  const calls = [];
  const initial = deferred();
  const data = createProviderData({
    getProviders: () => initial.promise,
    onProvidersChanged: (callback) => { broadcast = callback; },
    getDashboard: async (pid) => { calls.push('dashboard:' + pid); return { pid }; },
    getHeatmap: async ({ provider }) => { calls.push('heatmap:' + provider); return { provider }; }
  });
  data.init();
  return { data, calls, initial, changed: (change) => broadcast([{ id: 'fresh' }], change) };
}

test('provider broadcasts cannot be overwritten by the slower startup snapshot', async () => {
  const { data, changed, initial } = makeData();
  changed({ providerId: 'codex', channel: 'quota' });
  initial.resolve([{ id: 'old' }]);
  await flush();
  assert.deepEqual(data.getSnapshot(), [{ id: 'fresh' }]);
});

test('quota/status changes perform no data queries; usage invalidates only affected views', async () => {
  const { data, changed, calls } = makeData();
  for (const pid of ['deepseek', 'dsh']) data.dashboards.subscribe(pid, () => {});
  for (const pid of ['all', 'deepseek', 'codex', 'dsh']) {
    data.heatmaps.subscribe(JSON.stringify([pid, 2026]), () => {});
  }
  await flush();
  calls.length = 0;
  changed({ providerId: 'codex', channel: 'quota' });
  changed({ providerId: 'deepseek', channel: 'status' });
  await flush();
  assert.deepEqual(calls, []);
  changed({ providerId: 'deepseek', channel: 'usage' });
  await flush();
  assert.deepEqual(calls.sort(), ['dashboard:deepseek', 'heatmap:all', 'heatmap:deepseek']);
  calls.length = 0;
  changed({ providerId: 'dsh', channel: 'localLog' });
  await flush();
  assert.deepEqual(calls.sort(), ['dashboard:dsh', 'heatmap:all', 'heatmap:dsh']);
  calls.length = 0;
  changed({ providerId: 'deepseek', channel: 'balance' });
  await flush();
  assert.deepEqual(calls, ['dashboard:deepseek']);
});

test('bar chart and heatmap share requests; history and legacy broadcasts refresh active views', async () => {
  const { data, changed, calls } = makeData();
  const key = JSON.stringify(['all', 2026]);
  data.heatmaps.subscribe(key, () => {});
  data.heatmaps.subscribe(key, () => {});
  await flush();
  assert.deepEqual(calls, ['heatmap:all']);
  changed({ providerId: '__all__', channel: 'all' });
  await flush();
  changed(undefined);
  await flush();
  assert.equal(calls.length, 3);
});
