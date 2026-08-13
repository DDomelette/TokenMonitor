const test = require('node:test');
const assert = require('node:assert/strict');

const { createTokenSpeedTracker, PROVIDER_IDS } = require('../src/main/core/token-speed-tracker');

test('PROVIDER_IDS includes dsh', () => {
  assert.deepEqual(PROVIDER_IDS, ['deepseek', 'codex', 'kimi', 'dsh']);
});

test('dsh observes, samples, and computes window metrics like other providers', () => {
  let now = 1000000;
  const tracker = createTokenSpeedTracker({ now: () => now });
  tracker.observe({ providerId: 'dsh', dayKey: '2026-08-14', totalTokens: 0 });
  tracker.sample();
  now += 60000;
  tracker.observe({ providerId: 'dsh', dayKey: '2026-08-14', totalTokens: 600 });
  tracker.sample();

  const snapshot = tracker.getSnapshot({ providerFilter: 'dsh', intervalSeconds: 60, at: now });
  assert.equal(snapshot.providerFilter, 'dsh');
  const dsh = snapshot.providers.find((p) => p.providerId === 'dsh');
  assert.ok(dsh);
  assert.equal(dsh.status, 'ok');
  assert.equal(dsh.deltaTokens, 600);
  assert.equal(dsh.tokensPerMinute, 600);
});

test('unknown provider ids still throw', () => {
  const tracker = createTokenSpeedTracker({ now: () => 0 });
  assert.throws(() => tracker.observe({ providerId: 'nope', totalTokens: 1 }), /Unknown token speed provider/);
});
