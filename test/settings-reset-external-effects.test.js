const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadWindowSettings() {
  return require('../src/main/core/window-settings');
}

test('auto-launch setting applies false without requiring a main window', () => {
  const { applyWindowSetting } = loadWindowSettings();
  const calls = [];

  const handled = applyWindowSetting({
    key: 'window.autoLaunch',
    value: false,
    app: {
      setLoginItemSettings(settings) {
        calls.push(settings);
      }
    },
    mainWindow: null,
    applyTheme() {
      throw new Error('theme must not be touched');
    }
  });

  assert.equal(handled, true);
  assert.deepEqual(calls, [{ openAtLogin: false }]);
});

test('always-on-top remains a live-main-window effect', () => {
  const { applyWindowSetting } = loadWindowSettings();
  const values = [];
  const mainWindow = {
    isDestroyed: () => false,
    setAlwaysOnTop(value) {
      values.push(value);
    }
  };

  assert.equal(applyWindowSetting({
    key: 'window.alwaysOnTop',
    value: true,
    app: {},
    mainWindow,
    applyTheme() {}
  }), true);
  assert.deepEqual(values, [true]);

  assert.equal(applyWindowSetting({
    key: 'window.alwaysOnTop',
    value: false,
    app: {},
    mainWindow: null,
    applyTheme() {}
  }), true);
  assert.deepEqual(values, [true], 'missing windows must not receive a call');
});

test('reset replay applies stored always-on-top and auto-launch values without coercing false', () => {
  const { applyResetWindowSettings } = loadWindowSettings();
  const values = new Map([
    ['window.alwaysOnTop', true],
    ['window.autoLaunch', false]
  ]);
  const calls = [];

  const applied = applyResetWindowSettings({
    store: { get: (key) => values.get(key) },
    applySetting(key, value) {
      calls.push([key, value]);
    }
  });

  assert.deepEqual(applied, ['window.alwaysOnTop', 'window.autoLaunch']);
  assert.deepEqual(calls, [
    ['window.alwaysOnTop', true],
    ['window.autoLaunch', false]
  ]);
});

test('settings reset replays external effects after clearing the store and before broadcast', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/ipc.js'),
    'utf8'
  );

  assert.match(
    source,
    /const \{ applyResetWindowSettings \} = require\('\.\/core\/window-settings'\);/
  );
  assert.match(
    source,
    /resetSettingsStore\(deps\.store\);[\s\S]*?applyResetWindowSettings\(\{[\s\S]*?store:\s*deps\.store,[\s\S]*?applySetting:\s*deps\.applySetting[\s\S]*?\}\);[\s\S]*?deps\.broadcastSettings\(\);/
  );
  assert.doesNotMatch(
    source,
    /ipcMain\.on\('settings:reset'[\s\S]*?getMain\(\)\.setAlwaysOnTop/
  );
});

test('main process delegates canonical setting application to the window-settings module', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/index.js'),
    'utf8'
  );

  assert.match(
    source,
    /const \{ applyWindowSetting \} = require\('\.\/core\/window-settings'\);/
  );
  assert.match(
    source,
    /function applySetting\(key, value\) \{\s*return applyWindowSetting\(\{[\s\S]*?key:\s*key,[\s\S]*?value:\s*value,[\s\S]*?app:\s*app,[\s\S]*?mainWindow:\s*mainWindow,[\s\S]*?applyTheme:\s*applyTheme[\s\S]*?\}\);\s*\}/
  );
});
