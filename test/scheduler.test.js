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
