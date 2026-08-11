const { isWritableSettingKey, resolveWritableSettingKey } = require('./settings-security');
const { normalizeStoredProxyValue, SYSTEM_PROXY_VALUE } = require('./proxy-settings');
const { pruneUsageDaily, normalizeHistoryDays } = require('./usage-retention');
const {
  normalizeIntervalSeconds,
  normalizeProviderFilter
} = require('./token-speed-settings');

const DEFAULT_HISTORY_DAYS = 7;

function normalizeSettingValue(targetKey, value) {
  if (targetKey === 'providers.proxyUrl') {
    return normalizeStoredProxyValue(value);
  }
  if (targetKey === 'data.historyDays') {
    // 自定义下拉框的 dataset.value 是字符串,入库前归一化为正整数
    const days = normalizeHistoryDays(value);
    return days === null ? DEFAULT_HISTORY_DAYS : days;
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
  if (targetKey === 'providers.proxyUrl' && value && value !== SYSTEM_PROXY_VALUE) {
    // 自定义代理保存成功时顺手记下"上次使用的地址",供设置页下次预填
    deps.store.set('providers.proxyUrlLastCustom', value);
  }
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
