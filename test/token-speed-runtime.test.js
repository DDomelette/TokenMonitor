const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenSpeedRuntime } = require('../src/main/core/token-speed-runtime');

const FIXED_NOW = new Date(2026, 7, 9, 12, 0, 0).getTime();

function getPath(object, key) {
  return key.split('.').reduce((value, part) => (
    value == null ? undefined : value[part]
  ), object);
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

function deletePath(object, key) {
  const parts = key.split('.');
  const final = parts.pop();
  const parent = parts.reduce((value, part) => (
    value == null ? undefined : value[part]
  ), object);
  if (parent && typeof parent === 'object') delete parent[final];
}

function runtimeHarness(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const store = {
    get(key) { return getPath(data, key); },
    set(key, value) { setPath(data, key, value); },
    delete(key) { deletePath(data, key); }
  };
  const providers = [
    { id: 'deepseek', capabilities: { localLog: false } },
    { id: 'codex', capabilities: { localLog: true } },
    { id: 'kimi', capabilities: { localLog: true } },
    { id: 'dsh', capabilities: { localLog: true } }
  ];
  const registry = {
    list() { return providers.slice(); },
    get(id) { return providers.find((provider) => provider.id === id); }
  };
  const intervals = [];
  const polls = [];
  const broadcasts = [];
  let watchStarts = 0;
  let watchStops = 0;

  const runtime = createTokenSpeedRuntime({
    store,
    registry,
    scheduler: {
      poll(providerId, channel) {
        polls.push([providerId, channel]);
        return Promise.resolve();
      }
    },
    broadcast(channel, payload) { broadcasts.push({ channel, payload }); },
    now: () => FIXED_NOW,
    setIntervalFn(fn, ms) {
      const timer = { fn, ms, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn(timer) { timer.cleared = true; },
    watchServiceFactory() {
      return {
        start() { watchStarts += 1; },
        stop() { watchStops += 1; },
        ensure() { return true; },
        getStatus() { return { watching: true, delayed: false, reason: null }; }
      };
    }
  });

  const harness = { runtime, store, intervals, polls, broadcasts };
  Object.defineProperties(harness, {
    watchStarts: { get() { return watchStarts; } },
    watchStops: { get() { return watchStops; } }
  });
  return harness;
}

test('disabled startup creates no timers, watchers or persisted history', () => {
  const h = runtimeHarness({ components: { tokenSpeed: false } });
  h.runtime.start();
  assert.equal(h.runtime.isEnabled(), false);
  assert.equal(h.intervals.length, 0);
  assert.equal(h.watchStarts, 0);
  assert.equal(h.store.get('tokenSpeedRuntime'), undefined);
});

test('enabling establishes baselines, starts two timers and polls all usage sources', () => {
  const h = runtimeHarness({
    components: { tokenSpeed: false },
    data: { tokenSpeed: { intervalSeconds: 30, providerFilter: 'all' } },
    usageDaily: {
      'deepseek:2026-08-09': { total: 100 },
      'codex:2026-08-09': { total: 200 },
      'kimi:2026-08-09': { total: 300 }
    }
  });
  h.runtime.start();
  h.store.set('components.tokenSpeed', true);
  h.runtime.applySettings();
  assert.equal(h.runtime.isEnabled(), true);
  assert.equal(h.intervals.length, 2);
  assert.equal(h.watchStarts, 1);
  assert.deepEqual(h.polls, [
    ['deepseek', 'usage'], ['codex', 'localLog'], ['kimi', 'localLog'], ['dsh', 'localLog']
  ]);
  assert.equal(h.runtime.getSnapshot().providers[0].status, 'collecting');
});

test('selection changes keep history while disabling stops and deletes it', () => {
  const h = runtimeHarness({
    components: { tokenSpeed: true },
    data: { tokenSpeed: { intervalSeconds: 30, providerFilter: 'all' } }
  });
  h.runtime.start();
  h.store.set('data.tokenSpeed.intervalSeconds', 300);
  h.runtime.applySettings();
  assert.equal(h.runtime.getSnapshot().intervalSeconds, 300);
  h.store.set('components.tokenSpeed', false);
  h.runtime.applySettings();
  assert.equal(h.runtime.isEnabled(), false);
  assert.equal(h.watchStops, 1);
  assert.equal(h.store.get('tokenSpeedRuntime'), undefined);
});

test('flush persists at most six hours and startup restores a valid payload', () => {
  const first = runtimeHarness({
    components: { tokenSpeed: true },
    data: { tokenSpeed: { intervalSeconds: 30, providerFilter: 'all' } }
  });
  first.runtime.start();
  first.runtime.flush();
  const payload = first.store.get('tokenSpeedRuntime');
  assert.equal(payload.version, 1);
  const second = runtimeHarness({
    components: { tokenSpeed: true },
    data: { tokenSpeed: { intervalSeconds: 30, providerFilter: 'all' } },
    tokenSpeedRuntime: payload
  });
  second.runtime.start();
  assert.equal(second.runtime.isEnabled(), true);
});

test('rebaseline updates raw counters without creating a speed spike', () => {
  const h = runtimeHarness({
    components: { tokenSpeed: true },
    data: { tokenSpeed: { intervalSeconds: 30, providerFilter: 'deepseek' } },
    usageDaily: { 'deepseek:2026-08-09': { total: 100 } }
  });
  h.runtime.start();
  h.store.set('usageDaily.deepseek:2026-08-09', { total: 100000 });
  h.runtime.rebaselineAll();
  assert.notEqual(h.runtime.getSnapshot().providers[0].deltaTokens, 99900);
});

test('source failures update availability without adding off-cycle samples', () => {
  const h = runtimeHarness({
    components: { tokenSpeed: true },
    data: { tokenSpeed: { intervalSeconds: 30, providerFilter: 'deepseek' } },
    usageDaily: { 'deepseek:2026-08-09': { total: 100 } }
  });
  h.runtime.start();
  const before = h.runtime.getSnapshot();

  h.runtime.markProviderUnavailable('deepseek', {
    channel: 'usage',
    observedAt: FIXED_NOW + 1234
  });

  const after = h.runtime.getSnapshot();
  assert.equal(after.series.deepseek.length, before.series.deepseek.length);
  assert.equal(after.providers[0].status, 'unavailable');
});
