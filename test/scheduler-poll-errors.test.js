const test = require('node:test');
const assert = require('node:assert/strict');

const { startScheduler } = require('../src/main/core/scheduler');

function makeStore() {
  return {
    get() { return null; }
  };
}

function makeRegistry(adapter) {
  return {
    list: () => [adapter],
    get: (id) => (id === adapter.id ? adapter : undefined)
  };
}

function makeAdapter(overrides) {
  return Object.assign({
    id: 'fake',
    displayName: 'Fake',
    capabilities: {
      balance: false,
      webUsage: false,
      quota: false,
      localLog: false,
      realtimeProxy: false
    },
    authStatus() { return 'ok'; }
  }, overrides);
}

function createHarness(adapter) {
  const broadcasts = [];
  const scheduler = startScheduler({
    registry: makeRegistry(adapter),
    store: makeStore(),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    intervals: false
  });
  broadcasts.length = 0;
  return { broadcasts, scheduler };
}

function providerBroadcasts(broadcasts) {
  return broadcasts.filter((entry) => entry.channel === 'providers:changed');
}

function latestProvider(broadcasts) {
  const entries = providerBroadcasts(broadcasts);
  assert.ok(entries.length > 0, 'expected a providers:changed broadcast');
  return entries[entries.length - 1].payload.find((provider) => provider.id === 'fake');
}

test('timeout after a successful quota fetch broadcasts once and preserves stale quota data', async () => {
  const quota = { provider: 'fake', windows: [{ name: 'weekly' }] };
  let mode = 'success';
  const adapter = makeAdapter({
    capabilities: { balance: false, webUsage: false, quota: true, localLog: false, realtimeProxy: false },
    async fetchQuota() {
      if (mode === 'success') return quota;
      throw new Error('request timeout');
    }
  });
  const { broadcasts, scheduler } = createHarness(adapter);

  try {
    await scheduler.poll('fake', 'quota');
    const success = latestProvider(broadcasts);
    const lastFetchedAt = success.lastFetchedAt;
    assert.equal(success.quota, quota);
    assert.equal(success.lastError, null);
    assert.equal(success.stale, false);
    assert.equal(typeof lastFetchedAt, 'number');

    broadcasts.length = 0;
    mode = 'timeout';
    await scheduler.poll('fake', 'quota');

    assert.equal(providerBroadcasts(broadcasts).length, 1);
    const failed = latestProvider(broadcasts);
    assert.equal(failed.quota, quota, 'last successful quota must remain available');
    assert.equal(failed.lastError, 'request timeout');
    assert.equal(failed.lastErrorChannel, 'quota');
    assert.equal(typeof failed.lastFailedAt, 'number');
    assert.equal(failed.lastFetchedAt, lastFetchedAt);
    assert.equal(failed.stale, true);
  } finally {
    scheduler.stop();
  }
});

test('an identical repeated error on the same channel does not rebroadcast', async () => {
  const adapter = makeAdapter({
    capabilities: { balance: false, webUsage: false, quota: true, localLog: false, realtimeProxy: false },
    async fetchQuota() { throw new Error('HTTP 500'); }
  });
  const { broadcasts, scheduler } = createHarness(adapter);

  try {
    await scheduler.poll('fake', 'quota');
    assert.equal(providerBroadcasts(broadcasts).length, 1);
    broadcasts.length = 0;

    await scheduler.poll('fake', 'quota');
    assert.equal(providerBroadcasts(broadcasts).length, 0);
  } finally {
    scheduler.stop();
  }
});

for (const scenario of [
  { channel: 'usage', message: 'HTTP 503 Service Unavailable' },
  { channel: 'balance', message: 'proxy connect ECONNREFUSED 127.0.0.1:7890' }
]) {
  test(`${scenario.channel} ${scenario.message} broadcasts a non-auth failure snapshot`, async () => {
    const capabilities = { balance: false, webUsage: false, quota: false, localLog: false, realtimeProxy: false };
    capabilities[scenario.channel === 'usage' ? 'webUsage' : scenario.channel] = true;
    const method = scenario.channel === 'usage' ? 'fetchUsage' : 'fetchBalance';
    const adapter = makeAdapter({
      capabilities,
      [method]: async () => { throw new Error(scenario.message); }
    });
    const { broadcasts, scheduler } = createHarness(adapter);

    try {
      await scheduler.poll('fake', scenario.channel);
      assert.equal(providerBroadcasts(broadcasts).length, 1);
      const failed = latestProvider(broadcasts);
      assert.equal(failed.authStatus, 'ok');
      assert.equal(failed.lastError, scenario.message);
      assert.equal(failed.lastErrorChannel, scenario.channel);
      assert.equal(failed.stale, false, 'no successful payload exists yet');
    } finally {
      scheduler.stop();
    }
  });
}

test('a later success clears only the recovered channel error and broadcasts fresh state', async () => {
  let mode = 'failure';
  const quota = { provider: 'fake', windows: [] };
  const adapter = makeAdapter({
    capabilities: { balance: false, webUsage: false, quota: true, localLog: false, realtimeProxy: false },
    async fetchQuota() {
      if (mode === 'failure') throw new Error('temporary upstream failure');
      return quota;
    }
  });
  const { broadcasts, scheduler } = createHarness(adapter);

  try {
    await scheduler.poll('fake', 'quota');
    broadcasts.length = 0;
    mode = 'success';

    await scheduler.poll('fake', 'quota');
    assert.equal(providerBroadcasts(broadcasts).length, 1);
    const recovered = latestProvider(broadcasts);
    assert.equal(recovered.quota, quota);
    assert.equal(recovered.lastError, null);
    assert.equal(recovered.lastErrorChannel, null);
    assert.equal(recovered.lastFailedAt, null);
    assert.equal(recovered.stale, false);
    assert.equal(typeof recovered.lastFetchedAt, 'number');
  } finally {
    scheduler.stop();
  }
});
