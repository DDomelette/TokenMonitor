const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTokenSpeedTracker,
  MAX_POINTS_PER_PROVIDER,
  STORAGE_VERSION
} = require('../src/main/core/token-speed-tracker');

function observeAndSample(tracker, providerId, at, total, dayKey = '2026-08-09') {
  tracker.observe({ providerId, dayKey, totalTokens: total, observedAt: at });
  tracker.sample(at);
}

test('30-second window reports delta and normalizes by real elapsed time', () => {
  const tracker = createTokenSpeedTracker({ now: () => 0 });
  observeAndSample(tracker, 'deepseek', 0, 100);
  observeAndSample(tracker, 'deepseek', 10000, 130);
  observeAndSample(tracker, 'deepseek', 20000, 160);
  observeAndSample(tracker, 'deepseek', 35000, 220);
  const snapshot = tracker.getSnapshot({ intervalSeconds: 30, providerFilter: 'deepseek', at: 35000 });
  assert.equal(snapshot.providers[0].deltaTokens, 120);
  assert.equal(snapshot.providers[0].tokensPerMinute, 120 * 60000 / 35000);
  assert.equal(snapshot.providers[0].status, 'ok');
});

test('insufficient coverage stays collecting and never fabricates zero points', () => {
  const tracker = createTokenSpeedTracker({ now: () => 10000 });
  observeAndSample(tracker, 'codex', 0, 10);
  observeAndSample(tracker, 'codex', 10000, 10);
  const snapshot = tracker.getSnapshot({ intervalSeconds: 30, providerFilter: 'codex', at: 10000 });
  assert.equal(snapshot.providers[0].status, 'collecting');
  assert.equal(snapshot.providers[0].tokensPerMinute, null);
  assert.equal(snapshot.series.codex.at(-1).tokensPerMinute, null);
});

test('day rollover adds the new-day counter while same-day rollback only rebaselines', () => {
  const tracker = createTokenSpeedTracker({ now: () => 30000 });
  observeAndSample(tracker, 'kimi', 0, 100, '2026-08-09');
  observeAndSample(tracker, 'kimi', 10000, 150, '2026-08-09');
  observeAndSample(tracker, 'kimi', 20000, 20, '2026-08-10');
  tracker.observe({ providerId: 'kimi', dayKey: '2026-08-10', totalTokens: 5, observedAt: 25000 });
  tracker.sample(30000);
  const state = tracker.serialize(30000).states.kimi;
  assert.equal(state.logicalTotal, 70);
  assert.equal(state.rawTotal, 5);
});

test('unavailable samples form gaps and recovery is marked offline', () => {
  const tracker = createTokenSpeedTracker({ now: () => 40000 });
  observeAndSample(tracker, 'deepseek', 0, 100);
  tracker.markUnavailable('deepseek', { at: 10000, reason: 'network' });
  tracker.sample(10000);
  tracker.sample(20000);
  tracker.observe({ providerId: 'deepseek', dayKey: '2026-08-09', totalTokens: 180, observedAt: 40000 });
  tracker.sample(40000);
  const snapshot = tracker.getSnapshot({ intervalSeconds: 30, providerFilter: 'deepseek', at: 40000 });
  assert.equal(snapshot.providers[0].quality, 'offline');
  assert.equal(snapshot.series.deepseek.at(-2).tokensPerMinute, null);
});

test('history is bounded, serialized and rejects stale payloads', () => {
  const tracker = createTokenSpeedTracker({ now: () => 30000000 });
  tracker.observe({ providerId: 'codex', dayKey: '2026-08-09', totalTokens: 0, observedAt: 0 });
  for (let index = 0; index < MAX_POINTS_PER_PROVIDER + 25; index += 1) {
    tracker.observe({ providerId: 'codex', dayKey: '2026-08-09', totalTokens: index, observedAt: index * 10000 });
    tracker.sample(index * 10000);
  }
  assert.equal(tracker.getPointCount('codex'), MAX_POINTS_PER_PROVIDER);
  const payload = tracker.serialize(21590000);
  assert.equal(payload.version, STORAGE_VERSION);

  const restored = createTokenSpeedTracker({ now: () => 21600000 });
  assert.equal(restored.hydrate(payload, 21600000), true);
  assert.equal(restored.getPointCount('codex'), MAX_POINTS_PER_PROVIDER);
  assert.equal(restored.hydrate(Object.assign({}, payload, { savedAt: 0 }), 30000000), false);
});

test('all filter returns three series while one-provider filters return one', () => {
  const tracker = createTokenSpeedTracker({ now: () => 30000 });
  ['deepseek', 'codex', 'kimi'].forEach((providerId) => {
    observeAndSample(tracker, providerId, 0, 0);
    observeAndSample(tracker, providerId, 30000, 30);
  });
  assert.deepEqual(Object.keys(tracker.getSnapshot({ intervalSeconds: 30, providerFilter: 'all', at: 30000 }).series), ['deepseek', 'codex', 'kimi']);
  assert.deepEqual(Object.keys(tracker.getSnapshot({ intervalSeconds: 30, providerFilter: 'kimi', at: 30000 }).series), ['kimi']);
});
