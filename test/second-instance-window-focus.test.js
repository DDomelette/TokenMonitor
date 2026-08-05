const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const policyPath = path.join(root, 'src', 'main', 'core', 'startup-windows.js');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadPolicy() {
  delete require.cache[require.resolve(policyPath)];
  return require(policyPath);
}

function makeWindow(options = {}) {
  return {
    destroyed: !!options.destroyed,
    minimized: !!options.minimized,
    calls: [],
    focus() { this.calls.push('focus'); },
    isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized; },
    restore() {
      this.calls.push('restore');
      this.minimized = false;
    },
    show() { this.calls.push('show'); }
  };
}

test('second-instance prioritizes and restores the main window', () => {
  const { wakeMostRelevantWindow } = loadPolicy();
  assert.equal(typeof wakeMostRelevantWindow, 'function');

  const main = makeWindow({ minimized: true });
  const login = makeWindow();
  const settings = makeWindow();
  const result = wakeMostRelevantWindow({
    getMainWindow: () => main,
    getLoginWindow: () => login,
    getSettingsWindow: () => settings
  });

  assert.equal(result, main);
  assert.deepEqual(main.calls, ['restore', 'show', 'focus']);
  assert.deepEqual(login.calls, []);
  assert.deepEqual(settings.calls, []);
});

test('second-instance wakes the login window when no usable main window exists', () => {
  const { wakeMostRelevantWindow } = loadPolicy();
  const destroyedMain = makeWindow({ destroyed: true });
  const login = makeWindow({ minimized: true });

  const result = wakeMostRelevantWindow({
    getMainWindow: () => destroyedMain,
    getLoginWindow: () => login,
    getSettingsWindow: () => null
  });

  assert.equal(result, login);
  assert.deepEqual(login.calls, ['restore', 'show', 'focus']);
});

test('second-instance falls back to settings and tolerates missing optional window methods', () => {
  const { wakeMostRelevantWindow } = loadPolicy();
  const settings = {
    destroyed: false,
    calls: [],
    isDestroyed() { return false; },
    show() { this.calls.push('show'); },
    focus() { this.calls.push('focus'); }
  };

  const result = wakeMostRelevantWindow({
    getMainWindow: () => null,
    getLoginWindow: () => null,
    getSettingsWindow: () => settings
  });

  assert.equal(result, settings);
  assert.deepEqual(settings.calls, ['show', 'focus']);
});

test('second-instance is a safe no-op when every application window is absent or destroyed', () => {
  const { wakeMostRelevantWindow } = loadPolicy();
  const result = wakeMostRelevantWindow({
    getMainWindow: () => null,
    getLoginWindow: () => makeWindow({ destroyed: true }),
    getSettingsWindow: () => null
  });
  assert.equal(result, null);
});

test('main process delegates second-instance handling to the shared window policy', () => {
  const source = read('src/main/index.js');
  assert.match(source, /require\('\.\/core\/startup-windows'\)/);

  const handler = source.match(/app\.on\('second-instance',[\s\S]*?\n\}\);/)?.[0] || '';
  assert.match(handler, /wakeMostRelevantWindow\(\{/);
  assert.match(handler, /getMainWindow:\s*\(\)\s*=>\s*mainWindow/);
  assert.match(handler, /getLoginWindow:\s*\(\)\s*=>\s*loginWindow/);
  assert.match(handler, /getSettingsWindow:\s*\(\)\s*=>\s*settingsWindow/);
  assert.doesNotMatch(handler, /mainWindow\.show\(\)/);
});
