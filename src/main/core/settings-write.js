const { isWritableSettingKey, resolveWritableSettingKey } = require('./settings-security');

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
  deps.store.set(targetKey, payload.value);

  if (typeof deps.applySetting === 'function') {
    deps.applySetting(targetKey, payload.value);
  }
  if (typeof deps.broadcastSettings === 'function') {
    deps.broadcastSettings();
  }

  return { ok: true };
}

module.exports = {
  saveSetting
};
