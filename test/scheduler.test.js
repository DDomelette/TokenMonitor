const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// 纯 node 环境 mock electron(app.getPath),让 electron-store 可实例化。
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: (name) => (name === 'userData'
        ? path.join(os.tmpdir(), 'dsm-test-userdata')
        : path.join(os.tmpdir(), 'dsm-test'))
    }
  }
};

const { migrateLegacyKeys } = require('../src/main/store');
const { startScheduler } = require('../src/main/core/scheduler');

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) return;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
}

function makeFakeStore(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  return {
    data,
    get(k) { return getPath(data, k); },
    set(k, v) { setPath(data, k, v); },
    delete(k) { deletePath(data, k); }
  };
}

function makeFakeAdapter(overrides) {
  return Object.assign({
    id: 'fake',
    displayName: 'Fake',
    capabilities: { balance: false, webUsage: false, quota: true, localLog: false, realtimeProxy: false },
    authStatus() { return 'ok'; }
  }, overrides);
}

function makeRegistry(adapters) {
  return {
    list: () => adapters.slice(),
    get: (id) => adapters.find((a) => a.id === id)
  };
}

test('migrateLegacyKeys moves legacy sessionToken/apiKey into provider namespace', () => {
  const store = makeFakeStore({ sessionToken: 'tok', apiKey: 'key' });
  const migrated = migrateLegacyKeys(store);
  assert.equal(migrated, true);
  assert.equal(store.get('providers.deepseek.sessionToken'), 'tok');
  assert.equal(store.get('providers.deepseek.apiKey'), 'key');
  assert.equal(store.get('sessionToken'), undefined);
  assert.equal(store.get('apiKey'), undefined);
});

test('migrateLegacyKeys keeps an already-migrated value and cleans the old key', () => {
  const store = makeFakeStore({
    sessionToken: 'old',
    apiKey: 'oldkey',
    providers: { deepseek: { sessionToken: 'new', apiKey: 'newkey' } }
  });
  const migrated = migrateLegacyKeys(store);
  assert.equal(migrated, false);
  assert.equal(store.get('providers.deepseek.sessionToken'), 'new');
  assert.equal(store.get('providers.deepseek.apiKey'), 'newkey');
  assert.equal(store.get('sessionToken'), undefined);
  assert.equal(store.get('apiKey'), undefined);
});

test('scheduler broadcasts quota snapshot on successful fetch', async () => {
  const quota = { provider: 'fake', billingMode: 'subscription', windows: [], fetchedAt: Date.now() };
  const adapter = makeFakeAdapter({ fetchQuota: async () => quota });
  const broadcasts = [];
  const scheduler = startScheduler({
    registry: makeRegistry([adapter]),
    store: makeFakeStore({}),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    intervals: false
  });
  try {
    await scheduler.poll('fake', 'quota');
    assert.ok(broadcasts.some((b) => b.channel === 'providers:changed'));
    const snap = broadcasts.filter((b) => b.channel === 'providers:changed').pop()
      .payload.find((p) => p.id === 'fake');
    assert.equal(snap.quota, quota);
    assert.equal(snap.authStatus, 'ok');
    assert.equal(snap.lastError, null);
  } finally {
    scheduler.stop();
  }
});

test('scheduler marks authStatus expired and broadcasts a safe summary on 401 quota error', async () => {
  const adapter = makeFakeAdapter({
    fetchQuota: async () => { throw new Error('Unauthorized: session expired (HTTP 401)'); }
  });
  const broadcasts = [];
  const scheduler = startScheduler({
    registry: makeRegistry([adapter]),
    store: makeFakeStore({}),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    intervals: false
  });
  try {
    await scheduler.poll('fake', 'quota');
    const last = broadcasts.filter((b) => b.channel === 'providers:changed').pop();
    const snap = last.payload.find((p) => p.id === 'fake');
    assert.equal(snap.authStatus, 'expired');
    assert.equal(snap.lastError, '认证已过期或无效');
  } finally {
    scheduler.stop();
  }
});

test('scheduler reports successful web usage and local-log observations', async () => {
  const observations = [];
  const web = makeFakeAdapter({
    id: 'web',
    capabilities: { balance: false, webUsage: true, quota: false, localLog: false, realtimeProxy: false },
    fetchUsage: async () => ({ amount: { aggregate: { todayTokens: 10 } } })
  });
  const local = makeFakeAdapter({
    id: 'local',
    capabilities: { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false },
    readLocalLog: async () => []
  });
  const scheduler = startScheduler({
    registry: makeRegistry([web, local]),
    store: makeFakeStore({}),
    broadcast() {},
    intervals: false,
    onUsageObservation(providerId, detail) { observations.push([providerId, detail.channel]); }
  });
  await scheduler.poll('web', 'usage');
  await scheduler.poll('local', 'localLog');
  assert.deepEqual(observations, [['web', 'usage'], ['local', 'localLog']]);
  scheduler.stop();
});

test('scheduler reports usage-source failures without exposing raw errors', async () => {
  const unavailable = [];
  const web = makeFakeAdapter({
    capabilities: { balance: false, webUsage: true, quota: false, localLog: false, realtimeProxy: false },
    fetchUsage: async () => { throw new Error('secret upstream body'); }
  });
  const scheduler = startScheduler({
    registry: makeRegistry([web]), store: makeFakeStore({}), broadcast() {}, intervals: false,
    onUsageUnavailable(providerId, detail) { unavailable.push([providerId, detail.channel]); }
  });
  await scheduler.poll('fake', 'usage');
  assert.deepEqual(unavailable, [['fake', 'usage']]);
  scheduler.stop();
});

test('quota success persists lastQuota and exposes quotaFetchedAt in snapshot', async () => {
  const quota = { provider: 'fake', billingMode: 'subscription', windows: [], planName: 'pro' };
  const store = makeFakeStore({});
  const scheduler = startScheduler({
    registry: makeRegistry([makeFakeAdapter({ fetchQuota: async () => quota })]),
    store,
    broadcast() {},
    intervals: false
  });
  try {
    await scheduler.poll('fake', 'quota');
    const persisted = store.get('providers.fake.lastQuota');
    assert.equal(persisted.quota, quota);
    assert.ok(Number.isFinite(persisted.fetchedAt));
    const snap = scheduler.getSnapshot().find((p) => p.id === 'fake');
    assert.equal(snap.quotaFetchedAt, persisted.fetchedAt);
  } finally {
    scheduler.stop();
  }
});

test('cold start seeds quota snapshot from persisted lastQuota', () => {
  const quota = { provider: 'fake', billingMode: 'subscription', windows: [] };
  const store = makeFakeStore({
    providers: { fake: { lastQuota: { quota: quota, fetchedAt: 1234567890 } } }
  });
  const scheduler = startScheduler({
    registry: makeRegistry([makeFakeAdapter({})]),
    store,
    broadcast() {},
    intervals: false
  });
  try {
    const snap = scheduler.getSnapshot().find((p) => p.id === 'fake');
    assert.deepEqual(snap.quota, quota, '首轮轮询前快照就应带有上次成功的额度');
    assert.equal(snap.quotaFetchedAt, 1234567890);
  } finally {
    scheduler.stop();
  }
});

test('failed poll keeps last good quota: update on success, keep on failure', async () => {
  const quota = { provider: 'fake', billingMode: 'subscription', windows: [] };
  let fail = false;
  const adapter = makeFakeAdapter({
    fetchQuota: async () => {
      if (fail) throw new Error('Unauthorized: session expired (HTTP 401)');
      return quota;
    }
  });
  const scheduler = startScheduler({
    registry: makeRegistry([adapter]),
    store: makeFakeStore({}),
    broadcast() {},
    intervals: false
  });
  try {
    await scheduler.poll('fake', 'quota');
    const fetchedAt = scheduler.getSnapshot().find((p) => p.id === 'fake').quotaFetchedAt;
    fail = true;
    await scheduler.poll('fake', 'quota');
    const snap = scheduler.getSnapshot().find((p) => p.id === 'fake');
    assert.equal(snap.authStatus, 'expired');
    assert.equal(snap.quota, quota, '失败后快照必须保持上次成功的额度');
    assert.equal(snap.quotaFetchedAt, fetchedAt, '数据时间不应被失败覆盖');
    fail = false;
    const quota2 = Object.assign({}, quota, { planName: 'plus' });
    adapter.fetchQuota = async () => quota2;
    await scheduler.poll('fake', 'quota');
    const snap2 = scheduler.getSnapshot().find((p) => p.id === 'fake');
    assert.equal(snap2.authStatus, 'ok');
    assert.equal(snap2.quota, quota2, '恢复成功后快照更新为新数据');
  } finally {
    scheduler.stop();
  }
});

test('runExclusive serializes same-key functions and lets other keys run concurrently', async () => {
  const scheduler = startScheduler({
    registry: makeRegistry([]), store: makeFakeStore({}), broadcast() {}, intervals: false
  });
  try {
    const order = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const first = scheduler.runExclusive('codex', 'localLog', async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
    });
    const second = scheduler.runExclusive('codex', 'localLog', async () => {
      order.push('second');
    });
    const kimi = scheduler.runExclusive('kimi', 'localLog', async () => {
      order.push('kimi');
    });

    // kimi 使用不同 key,可立即执行;同 key 的 second 必须排队等待 first 完成
    assert.deepEqual(order, ['first:start', 'kimi']);
    release();
    await Promise.all([first, second, kimi]);
    assert.deepEqual(order, ['first:start', 'kimi', 'first:end', 'second']);
  } finally {
    scheduler.stop();
  }
});

test('runOnce coalesces a queued key so a second poll does not re-read', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = makeFakeAdapter({
    id: 'codex',
    capabilities: { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false },
    async readLocalLog() {
      calls += 1;
      await gate;
      return [];
    }
  });
  const scheduler = startScheduler({
    registry: makeRegistry([provider]), store: makeFakeStore({}), broadcast() {}, intervals: false
  });
  try {
    const first = scheduler.poll('codex', 'localLog');
    const second = scheduler.poll('codex', 'localLog');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'the second poll must coalesce onto the running task');
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1, 'runOnce must never invoke a second function for a queued key');
  } finally {
    scheduler.stop();
  }
});

test('a rejected exclusive task frees the key so the next queued task still runs', async () => {
  const scheduler = startScheduler({
    registry: makeRegistry([]), store: makeFakeStore({}), broadcast() {}, intervals: false
  });
  try {
    const order = [];
    const first = scheduler.runExclusive('codex', 'localLog', async () => {
      order.push('first');
      throw new Error('boom');
    });
    const second = scheduler.runExclusive('codex', 'localLog', async () => {
      order.push('second');
    });
    await assert.rejects(first, /boom/);
    await second;
    assert.deepEqual(order, ['first', 'second'], 'a prior rejection must not stall the queue');
  } finally {
    scheduler.stop();
  }
});
