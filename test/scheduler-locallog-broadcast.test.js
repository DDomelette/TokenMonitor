const test = require('node:test');
const assert = require('node:assert/strict');

const { startScheduler } = require('../src/main/core/scheduler');

function getPath(object, key) {
  return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
}

function setPath(object, key, value) {
  const parts = key.split('.');
  let current = object;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[0]] = value;
}

function makeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    get(key) { return getPath(data, key); },
    set(key, value) { setPath(data, key, value); }
  };
}

function makeRegistry(providers) {
  return {
    list() { return providers.slice(); },
    get(id) { return providers.find((provider) => provider.id === id); }
  };
}

function makeProvider(id, overrides = {}) {
  return Object.assign({
    id,
    displayName: id,
    capabilities: {
      balance: false,
      webUsage: false,
      quota: false,
      localLog: true,
      realtimeProxy: false
    },
    authStatus() { return 'ok'; }
  }, overrides);
}

function changedBroadcasts(broadcasts) {
  return broadcasts.filter((entry) => entry.channel === 'providers:changed');
}

test('a local-log scan with new records broadcasts exactly once after persistence', async () => {
  const store = makeStore({ usageDaily: {} });
  const provider = makeProvider('codex', {
    async readLocalLog(ctx) {
      ctx.store.set('usageDaily', {
        'codex:2026-08-06': { input: 2, cached: 0, output: 3, total: 5 }
      });
      return [{ provider: 'codex', ts: Date.now(), usage: { total: 5 } }];
    }
  });
  const broadcasts = [];
  const scheduler = startScheduler({
    registry: makeRegistry([provider]),
    store,
    broadcast(channel, payload) {
      broadcasts.push({ channel, payload, usageDaily: store.get('usageDaily') });
    },
    intervals: false
  });

  try {
    broadcasts.length = 0;
    await scheduler.poll('codex', 'localLog');

    const changes = changedBroadcasts(broadcasts);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].usageDaily['codex:2026-08-06'].total, 5);
  } finally {
    scheduler.stop();
  }
});

test('an empty local-log scan does not broadcast a meaningless redraw', async () => {
  const provider = makeProvider('codex', {
    async readLocalLog() {
      return [];
    }
  });
  const broadcasts = [];
  const scheduler = startScheduler({
    registry: makeRegistry([provider]),
    store: makeStore({ usageDaily: {} }),
    broadcast(channel, payload) { broadcasts.push({ channel, payload }); },
    intervals: false
  });

  try {
    broadcasts.length = 0;
    await scheduler.poll('codex', 'localLog');
    assert.deepEqual(changedBroadcasts(broadcasts), []);
  } finally {
    scheduler.stop();
  }
});

test('pollAll broadcasts the last provider only after its local-log data is persisted', async () => {
  const store = makeStore({ usageDaily: {} });
  const first = makeProvider('first', {
    capabilities: {
      balance: false,
      webUsage: false,
      quota: true,
      localLog: false,
      realtimeProxy: false
    },
    async fetchQuota() {
      return { provider: 'first', windows: [] };
    }
  });
  const last = makeProvider('kimi', {
    capabilities: {
      balance: false,
      webUsage: false,
      quota: true,
      localLog: true,
      realtimeProxy: false
    },
    async fetchQuota() {
      return { provider: 'kimi', windows: [] };
    },
    async readLocalLog(ctx) {
      ctx.store.set('usageDaily', {
        'kimi:2026-08-06': { input: 4, cached: 1, output: 4, total: 9 }
      });
      return [{ provider: 'kimi', ts: Date.now(), usage: { total: 9 } }];
    }
  });
  const broadcasts = [];
  const scheduler = startScheduler({
    registry: makeRegistry([first, last]),
    store,
    broadcast(channel) {
      const usageDaily = store.get('usageDaily') || {};
      broadcasts.push({
        channel,
        kimiTotal: usageDaily['kimi:2026-08-06']
          ? usageDaily['kimi:2026-08-06'].total
          : 0
      });
    },
    intervals: false
  });

  try {
    broadcasts.length = 0;
    await scheduler.pollAll();

    const changes = changedBroadcasts(broadcasts);
    assert.ok(changes.length >= 1);
    assert.equal(changes[changes.length - 1].kimiTotal, 9);
  } finally {
    scheduler.stop();
  }
});

test('local-log error recovery plus new data produces one combined notification', async () => {
  const store = makeStore({ usageDaily: {} });
  let attempt = 0;
  const provider = makeProvider('kimi', {
    async readLocalLog(ctx) {
      attempt += 1;
      if (attempt === 1) throw new Error('temporary local log failure');
      ctx.store.set('usageDaily', {
        'kimi:2026-08-06': { input: 1, cached: 0, output: 1, total: 2 }
      });
      return [{ provider: 'kimi', ts: Date.now(), usage: { total: 2 } }];
    }
  });
  const broadcasts = [];
  const scheduler = startScheduler({
    registry: makeRegistry([provider]),
    store,
    broadcast(channel, payload) { broadcasts.push({ channel, payload }); },
    intervals: false
  });

  try {
    broadcasts.length = 0;
    await scheduler.poll('kimi', 'localLog');
    assert.equal(changedBroadcasts(broadcasts).length, 1, 'failure should notify once');

    broadcasts.length = 0;
    await scheduler.poll('kimi', 'localLog');
    const changes = changedBroadcasts(broadcasts);
    assert.equal(changes.length, 1, 'recovery and data change must be coalesced');
    const kimi = changes[0].payload.find((entry) => entry.id === 'kimi');
    assert.equal(kimi.lastError, null);
  } finally {
    scheduler.stop();
  }
});

test('codex local-log poll routes through the usage runtime', async () => {
  const store = makeStore({ usageDaily: {} });
  const seen = [];
  const runtime = {
    async runIncremental(fn) {
      return fn({ mode: 'uuid' });
    }
  };
  const provider = makeProvider('codex', {
    async readLocalLog(ctx, opts) {
      seen.push(opts);
      ctx.store.set('usageDaily', {
        'codex:2026-08-06': { input: 2, cached: 0, output: 3, total: 5 }
      });
      return [{ provider: 'codex', ts: Date.now(), usage: { total: 5 } }];
    }
  });
  const broadcasts = [];
  const scheduler = startScheduler({
    registry: makeRegistry([provider]),
    store,
    broadcast(channel, payload) { broadcasts.push({ channel, payload }); },
    intervals: false,
    codexUsageRuntime: runtime
  });

  try {
    broadcasts.length = 0;
    await scheduler.poll('codex', 'localLog');
    assert.deepEqual(seen, [{ mode: 'uuid' }], 'codex read receives the runtime-supplied mode');
    assert.equal(changedBroadcasts(broadcasts).length, 1);
  } finally {
    scheduler.stop();
  }
});

test('kimi local-log poll bypasses the codex runtime', async () => {
  const seen = [];
  const runtime = {
    async runIncremental() {
      throw new Error('must not be used for kimi');
    }
  };
  const provider = makeProvider('kimi', {
    async readLocalLog(ctx, opts) {
      seen.push(opts);
      return [];
    }
  });
  const scheduler = startScheduler({
    registry: makeRegistry([provider]),
    store: makeStore({}),
    broadcast() {},
    intervals: false,
    codexUsageRuntime: runtime
  });

  try {
    await scheduler.poll('kimi', 'localLog');
    assert.deepEqual(seen, [undefined], 'kimi read is called directly without runtime options');
  } finally {
    scheduler.stop();
  }
});
