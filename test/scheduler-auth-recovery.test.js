const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startScheduler } = require('../src/main/core/scheduler');

function makeStore() {
  return { get() { return null; } };
}

function makeRegistry(adapter) {
  return {
    list: () => [adapter],
    get: (id) => (id === adapter.id ? adapter : undefined)
  };
}

function providerBroadcasts(broadcasts) {
  return broadcasts.filter((entry) => entry.channel === 'providers:changed');
}

function createHarness(adapter) {
  const broadcasts = [];
  const scheduler = startScheduler({
    registry: makeRegistry(adapter),
    store: makeStore(),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    intervals: false
  });
  return { broadcasts, scheduler };
}

function snapshot(scheduler) {
  return scheduler.getSnapshot().find((provider) => provider.id === 'fake');
}

test('credential file creation and deletion recover ok then return to missing at runtime', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-auth-recovery-'));
  const credentialPath = path.join(root, 'credential.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const quota = { provider: 'fake', windows: [{ kind: 'weekly', remaining: 42 }] };
  let fetchCount = 0;
  const adapter = {
    id: 'fake',
    displayName: 'Fake',
    capabilities: { balance: false, webUsage: false, quota: true, localLog: false, realtimeProxy: false },
    authStatus() {
      return fs.existsSync(credentialPath) ? 'ok' : 'missing';
    },
    async fetchQuota() {
      fetchCount += 1;
      if (!fs.existsSync(credentialPath)) throw new Error('credential file missing');
      return quota;
    }
  };
  const { broadcasts, scheduler } = createHarness(adapter);
  t.after(() => scheduler.stop());

  assert.equal(snapshot(scheduler).authStatus, 'missing');
  broadcasts.length = 0;

  await scheduler.poll('fake', 'quota');
  assert.equal(fetchCount, 0, 'a definitive missing preflight must skip the protected request');
  assert.equal(providerBroadcasts(broadcasts).length, 0, 'unchanged missing state must remain quiet');

  fs.writeFileSync(credentialPath, '{}');
  await scheduler.poll('fake', 'quota');

  assert.equal(fetchCount, 1);
  assert.equal(providerBroadcasts(broadcasts).length, 1);
  const recovered = snapshot(scheduler);
  assert.equal(recovered.authStatus, 'ok');
  assert.strictEqual(recovered.quota, quota);
  assert.equal(typeof recovered.lastFetchedAt, 'number');
  const lastFetchedAt = recovered.lastFetchedAt;

  broadcasts.length = 0;
  fs.unlinkSync(credentialPath);
  await scheduler.poll('fake', 'quota');

  assert.equal(fetchCount, 1, 'credential deletion must be detected before another request');
  assert.equal(providerBroadcasts(broadcasts).length, 1);
  const missing = snapshot(scheduler);
  assert.equal(missing.authStatus, 'missing');
  assert.strictEqual(missing.quota, quota, 'last successful payload must remain available');
  assert.equal(missing.lastFetchedAt, lastFetchedAt);
  assert.equal(missing.lastError, null);
});

for (const channel of ['balance', 'usage', 'quota']) {
  for (const initialStatus of ['missing', 'expired']) {
    test(`${channel} success recovers ${initialStatus} authentication to ok`, async (t) => {
      let observedStatus = initialStatus;
      const capabilities = { balance: false, webUsage: false, quota: false, localLog: false, realtimeProxy: false };
      const method = channel === 'usage' ? 'fetchUsage' : `fetch${channel[0].toUpperCase()}${channel.slice(1)}`;
      capabilities[channel === 'usage' ? 'webUsage' : channel] = true;
      const payload = { channel, initialStatus };
      const adapter = {
        id: 'fake',
        displayName: 'Fake',
        capabilities,
        authStatus() { return observedStatus; },
        [method]: async () => payload
      };
      const { broadcasts, scheduler } = createHarness(adapter);
      t.after(() => scheduler.stop());

      assert.equal(snapshot(scheduler).authStatus, initialStatus);
      broadcasts.length = 0;
      observedStatus = 'ok';

      await scheduler.poll('fake', channel);

      assert.equal(providerBroadcasts(broadcasts).length, 1);
      assert.equal(snapshot(scheduler).authStatus, 'ok');
      assert.equal(typeof snapshot(scheduler).lastFetchedAt, 'number');
    });
  }
}
