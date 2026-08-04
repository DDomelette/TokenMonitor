const RESET_KEEP_KEYS = Object.freeze([
  'providers.deepseek.apiKey',
  'providers.deepseek.sessionToken',
  'providers.proxyUrl',
  'usageDaily',
  // usageDaily contains incrementally aggregated Codex records. Its byte cursor is
  // part of the same data state; retaining one without the other replays history.
  'localLogCursors.codex'
]);

function shouldRestore(value) {
  return value !== undefined && value !== '' && value !== null;
}

function resetSettingsStore(store) {
  if (!store || typeof store.get !== 'function'
      || typeof store.set !== 'function' || typeof store.clear !== 'function') {
    throw new TypeError('resetSettingsStore requires a store with get/set/clear methods');
  }

  const kept = new Map();
  RESET_KEEP_KEYS.forEach((key) => {
    const value = store.get(key);
    if (shouldRestore(value)) kept.set(key, value);
  });

  store.clear();
  kept.forEach((value, key) => store.set(key, value));
  return Array.from(kept.keys());
}

module.exports = {
  RESET_KEEP_KEYS,
  resetSettingsStore,
  shouldRestore
};
