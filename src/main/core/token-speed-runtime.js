const { localDayStr } = require('./beijing-calendar');
const { effectiveDshDayTotal } = require('./dsh-usage-merge');
const { normalizeTokenSpeedSettings } = require('./token-speed-settings');
const {
  createTokenSpeedTracker,
  PROVIDER_IDS,
  SAMPLE_INTERVAL_MS
} = require('./token-speed-tracker');
const { createLocalLogWatchService } = require('./local-log-watch-service');

const PERSIST_INTERVAL_MS = 60000;
const STORAGE_KEY = 'tokenSpeedRuntime';

function readObservation(store, providerId, at) {
  const dayKey = localDayStr(at);
  let totalTokens;
  if (providerId === 'dsh') {
    totalTokens = effectiveDshDayTotal(store, dayKey);
  } else {
    const daily = store.get('usageDaily') || {};
    const row = daily[providerId + ':' + dayKey];
    totalTokens = Number(row && row.total) || 0;
  }
  return {
    providerId,
    dayKey,
    totalTokens,
    observedAt: at
  };
}

function createTokenSpeedRuntime(options = {}) {
  const store = options.store;
  const registry = options.registry;
  const scheduler = options.scheduler;
  const broadcast = options.broadcast || (() => {});
  const now = options.now || Date.now;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const trackerFactory = options.trackerFactory || createTokenSpeedTracker;
  const watchServiceFactory = options.watchServiceFactory || createLocalLogWatchService;
  const tracker = trackerFactory({ now });

  let enabled = false;
  let running = false;
  let sampleTimer = null;
  let persistTimer = null;
  let settings = normalizeTokenSpeedSettings(store.get('data.tokenSpeed'));

  function getSnapshot() {
    if (!enabled) {
      return {
        enabled: false,
        intervalSeconds: settings.intervalSeconds,
        providerFilter: settings.providerFilter,
        providers: [],
        series: {}
      };
    }
    return Object.assign({ enabled: true }, tracker.getSnapshot({
      intervalSeconds: settings.intervalSeconds,
      providerFilter: settings.providerFilter,
      at: now()
    }));
  }

  function broadcastSnapshot() {
    broadcast('token-speed:changed', getSnapshot());
  }

  function poll(providerId, channel) {
    if (!scheduler || typeof scheduler.poll !== 'function') return;
    try {
      const result = scheduler.poll(providerId, channel);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {}
  }

  const watchService = watchServiceFactory({
    registry,
    store,
    onProviderChanged(providerId) {
      if (enabled) poll(providerId, 'localLog');
    },
    onStatus(providerId, status) {
      if (!PROVIDER_IDS.includes(providerId)) return;
      tracker.setDelayed(providerId, status.delayed === true);
      if (enabled) broadcastSnapshot();
    }
  });

  function stopTimers() {
    if (sampleTimer !== null) {
      clearIntervalFn(sampleTimer);
      sampleTimer = null;
    }
    if (persistTimer !== null) {
      clearIntervalFn(persistTimer);
      persistTimer = null;
    }
  }

  function sampleOnce() {
    if (!enabled) return;
    tracker.sample(now());
    broadcastSnapshot();
  }

  function flush() {
    if (!enabled) return false;
    store.set(STORAGE_KEY, tracker.serialize(now()));
    return true;
  }

  function enable() {
    enabled = true;
    const at = now();
    const hydrated = tracker.hydrate(store.get(STORAGE_KEY), at);
    if (!hydrated) {
      tracker.clear();
      store.delete(STORAGE_KEY);
    }
    PROVIDER_IDS.forEach((providerId) => {
      const observation = readObservation(store, providerId, at);
      if (hydrated) tracker.observe(observation);
      else tracker.rebaseline(observation);
    });
    tracker.sample(at);
    watchService.start();
    sampleTimer = setIntervalFn(sampleOnce, SAMPLE_INTERVAL_MS);
    persistTimer = setIntervalFn(flush, PERSIST_INTERVAL_MS);
    poll('deepseek', 'usage');
    poll('codex', 'localLog');
    poll('kimi', 'localLog');
    poll('dsh', 'localLog');
    broadcastSnapshot();
  }

  function disable() {
    stopTimers();
    watchService.stop();
    tracker.clear();
    store.delete(STORAGE_KEY);
    enabled = false;
    broadcastSnapshot();
  }

  function applySettings() {
    const shouldEnable = store.get('components.tokenSpeed') === true;
    settings = normalizeTokenSpeedSettings(store.get('data.tokenSpeed'));
    if (shouldEnable && !enabled) {
      enable();
    } else if (!shouldEnable && enabled) {
      disable();
    } else if (!shouldEnable) {
      tracker.clear();
      store.delete(STORAGE_KEY);
    } else {
      broadcastSnapshot();
    }
  }

  function start() {
    if (running) return;
    running = true;
    applySettings();
  }

  function observeProvider(providerId, observedAt = now()) {
    if (!enabled || !PROVIDER_IDS.includes(providerId)) return false;
    tracker.observe(readObservation(store, providerId, observedAt));
    const provider = registry && typeof registry.get === 'function'
      ? registry.get(providerId)
      : null;
    if (provider && provider.capabilities && provider.capabilities.localLog) {
      watchService.ensure(providerId);
    }
    return true;
  }

  function markProviderUnavailable(providerId, detail = {}) {
    if (!enabled || !PROVIDER_IDS.includes(providerId)) return false;
    tracker.markUnavailable(providerId, {
      at: Number.isFinite(Number(detail.observedAt)) ? Number(detail.observedAt) : now(),
      reason: detail.channel || 'source'
    });
    broadcastSnapshot();
    return true;
  }

  function rebaselineAll(at = now()) {
    if (!enabled) return false;
    PROVIDER_IDS.forEach((providerId) => {
      tracker.rebaseline(readObservation(store, providerId, at));
    });
    tracker.sample(at);
    broadcastSnapshot();
    return true;
  }

  function stop() {
    if (!running) return;
    if (enabled) flush();
    stopTimers();
    watchService.stop();
    enabled = false;
    running = false;
  }

  return {
    start,
    applySettings,
    observeProvider,
    markProviderUnavailable,
    rebaselineAll,
    getSnapshot,
    flush,
    stop,
    isEnabled() {
      return enabled;
    }
  };
}

module.exports = {
  PERSIST_INTERVAL_MS,
  STORAGE_KEY,
  readObservation,
  createTokenSpeedRuntime
};
