const fs = require('node:fs');

function createLocalLogWatchService(options = {}) {
  const registry = options.registry;
  const store = options.store;
  const fsImpl = options.fsImpl || fs;
  const onProviderChanged = options.onProviderChanged || (() => {});
  const onStatus = options.onStatus || (() => {});
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const debounceMs = Number.isFinite(Number(options.debounceMs))
    ? Number(options.debounceMs)
    : 500;
  const states = Object.create(null);
  let stopping = false;

  function stateFor(providerId) {
    if (!states[providerId]) {
      states[providerId] = {
        watcher: null,
        timer: null,
        debounceGeneration: 0,
        delayed: true,
        reason: 'not-started',
        suppressClose: false
      };
    }
    return states[providerId];
  }

  function getStatus(providerId) {
    const state = states[providerId];
    return state
      ? {
          watching: !!state.watcher,
          delayed: !!state.delayed,
          reason: state.reason || null
        }
      : { watching: false, delayed: true, reason: 'not-started' };
  }

  function publishStatus(providerId) {
    onStatus(providerId, getStatus(providerId));
  }

  function setStatus(providerId, delayed, reason) {
    const state = stateFor(providerId);
    state.delayed = delayed === true;
    state.reason = reason || null;
    publishStatus(providerId);
  }

  function scheduleProviderScan(providerId) {
    const state = stateFor(providerId);
    if (state.timer !== null) clearTimeoutFn(state.timer);
    state.debounceGeneration += 1;
    const generation = state.debounceGeneration;
    state.timer = setTimeoutFn(() => {
      if (stopping || state.debounceGeneration !== generation) return;
      state.timer = null;
      try {
        const result = onProviderChanged(providerId);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_) {}
    }, debounceMs);
  }

  function closeAfterError(state, watcher) {
    state.suppressClose = true;
    try {
      watcher.close();
    } catch (_) {}
    state.suppressClose = false;
  }

  function ensure(providerId) {
    if (stopping) return false;
    const provider = registry && typeof registry.get === 'function'
      ? registry.get(providerId)
      : null;
    if (!provider || !provider.capabilities || !provider.capabilities.localLog
      || typeof provider.localLogRoot !== 'function') {
      return false;
    }

    const state = stateFor(providerId);
    if (state.watcher) return true;

    let root;
    try {
      root = provider.localLogRoot({ store });
    } catch (_) {
      setStatus(providerId, true, 'missing-root');
      return false;
    }
    if (!root || !fsImpl.existsSync(root)) {
      setStatus(providerId, true, 'missing-root');
      return false;
    }

    let watcher;
    try {
      watcher = fsImpl.watch(root, { recursive: true }, () => {
        scheduleProviderScan(providerId);
      });
    } catch (_) {
      setStatus(providerId, true, 'watch-error');
      return false;
    }

    state.watcher = watcher;
    watcher.on('error', () => {
      if (stopping || state.watcher !== watcher) return;
      state.watcher = null;
      closeAfterError(state, watcher);
      setStatus(providerId, true, 'watch-error');
    });
    watcher.on('close', () => {
      if (stopping || state.suppressClose || state.watcher !== watcher) return;
      state.watcher = null;
      setStatus(providerId, true, 'watch-close');
    });
    setStatus(providerId, false, null);
    return true;
  }

  function start() {
    stopping = false;
    const providers = registry && typeof registry.list === 'function' ? registry.list() : [];
    providers.forEach((provider) => ensure(provider.id));
  }

  function stop() {
    stopping = true;
    Object.keys(states).forEach((providerId) => {
      const state = states[providerId];
      state.debounceGeneration += 1;
      if (state.timer !== null) {
        clearTimeoutFn(state.timer);
        state.timer = null;
      }
      const watcher = state.watcher;
      state.watcher = null;
      if (watcher) {
        state.suppressClose = true;
        try {
          watcher.close();
        } catch (_) {}
        state.suppressClose = false;
      }
    });
  }

  return {
    start,
    ensure,
    stop,
    getStatus
  };
}

module.exports = { createLocalLogWatchService };
