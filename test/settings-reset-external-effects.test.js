const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadResetPolicy() {
  return require('../src/main/core/settings-reset');
}

function createStore(initial, defaults) {
  const values = new Map(Object.entries(initial || {}));
  const resetDefaults = new Map(Object.entries(defaults || {}));
  return {
    get(key) {
      return values.get(key);
    },
    set(key, value) {
      values.set(key, value);
    },
    clear() {
      values.clear();
      resetDefaults.forEach((value, key) => values.set(key, value));
    }
  };
}

test('reset auto-launch synchronization preserves explicit false', () => {
  const { syncAutoLaunchAfterReset } = loadResetPolicy();
  const calls = [];
  const store = { get: (key) => key === 'window.autoLaunch' ? false : undefined };

  const applied = syncAutoLaunchAfterReset(store, {
    setLoginItemSettings(settings) {
      calls.push(settings);
    }
  });

  assert.equal(applied, true);
  assert.deepEqual(calls, [{ openAtLogin: false }]);
});

test('resetSettingsStore applies the post-clear auto-launch default after restoring preserved data', () => {
  const { resetSettingsStore } = loadResetPolicy();
  const calls = [];
  const store = createStore({
    'window.autoLaunch': true,
    'providers.deepseek.apiKey': 'preserved-key'
  }, {
    'window.autoLaunch': false,
    'window.alwaysOnTop': true
  });

  const restored = resetSettingsStore(store, {
    app: {
      setLoginItemSettings(settings) {
        calls.push(settings);
      }
    }
  });

  assert.equal(store.get('window.autoLaunch'), false);
  assert.equal(store.get('providers.deepseek.apiKey'), 'preserved-key');
  assert.deepEqual(restored, ['providers.deepseek.apiKey']);
  assert.deepEqual(calls, [{ openAtLogin: false }]);
});

test('reset auto-launch synchronization is a safe no-op when the Electron API is unavailable', () => {
  const { syncAutoLaunchAfterReset } = loadResetPolicy();
  const store = { get: () => false };

  assert.equal(syncAutoLaunchAfterReset(store, null), false);
  assert.equal(syncAutoLaunchAfterReset(store, {}), false);
});

test('settings reset keeps the existing always-on-top side effect before broadcasting', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/ipc.js'),
    'utf8'
  );

  assert.match(
    source,
    /resetSettingsStore\(deps\.store\);[\s\S]*?getMain\(\)\.setAlwaysOnTop\(true\);[\s\S]*?deps\.broadcastSettings\(\);/
  );
});

test('reset policy synchronizes the login item after clear and preserved-value restoration', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/core/settings-reset.js'),
    'utf8'
  );

  assert.match(source, /function syncAutoLaunchAfterReset\(store, appOverride\)/);
  assert.match(
    source,
    /store\.clear\(\);[\s\S]*?kept\.forEach\([\s\S]*?syncAutoLaunchAfterReset\(store, options && options\.app\);/
  );
  assert.match(source, /setLoginItemSettings\(\{ openAtLogin: autoLaunch === true \}\)/);
});
