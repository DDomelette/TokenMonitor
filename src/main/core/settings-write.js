const { isWritableSettingKey, resolveWritableSettingKey } = require('./settings-security');
const { normalizeStoredProxyValue } = require('./proxy-settings');
const { pruneUsageDaily } = require('./usage-retention');
const {
  normalizeIntervalSeconds,
  normalizeProviderFilter
} = require('./token-speed-settings');

function normalizeSettingValue(targetKey, value) {
  if (targetKey === 'providers.proxyUrl') {
    return normalizeStoredProxyValue(value);
  }
  if (targetKey === 'data.tokenSpeed.intervalSeconds') {
    return normalizeIntervalSeconds(value);
  }
  if (targetKey === 'data.tokenSpeed.providerFilter') {
    return normalizeProviderFilter(value);
  }
  return value;
}

function saveSetting(deps, payload) {
  if (!deps || !deps.store || typeof deps.store.set !== 'function') {
    throw new TypeError('saveSetting requires a writable settings store');
  }

  const key = payload && payload.key;
  if (typeof key !== 'string' || !isWritableSettingKey(key)) {
    const error = new Error('Setting key is not writable');
    error.code = 'SETTING_NOT_WRITABLE';
    throw error;
  }

  const targetKey = resolveWritableSettingKey(key);
  const value = normalizeSettingValue(targetKey, payload.value);
  deps.store.set(targetKey, value);
  if (targetKey === 'data.historyDays') {
    pruneUsageDaily(deps.store);
  }

  if (typeof deps.applySetting === 'function') {
    deps.applySetting(targetKey, value);
  }
  if (typeof deps.broadcastSettings === 'function') {
    deps.broadcastSettings();
  }

  return { ok: true };
}

module.exports = {
  saveSetting
};
