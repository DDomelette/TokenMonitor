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
  assert.equal(fs.existsSync(policyPath), true, 'startup window policy module must exist');
  delete require.cache[require.resolve(policyPath)];
  return require(policyPath);
}

function makeWindow() {
  return {
    closed: false,
    destroyed: false,
    shown: false,
    close() { this.closed = true; },
    isDestroyed() { return this.destroyed; },
    show() { this.shown = true; }
  };
}

function runInitialScenario(hasDeepseekApiKey) {
  const { openInitialWindows } = loadPolicy();
  let main = null;
  let login = null;
  let mainCreates = 0;
  let loginCreates = 0;

  const result = openInitialWindows({
    hasDeepseekApiKey,
    getMainWindow: () => main,
    getLoginWindow: () => login,
    createMainWindow() {
      mainCreates += 1;
      main = makeWindow();
    },
    createLoginWindow() {
      loginCreates += 1;
      login = makeWindow();
    }
  });

  return { result, main, login, mainCreates, loginCreates };
}

test('Codex-only, Kimi-only, and no-credential startup all create the main window before the optional DeepSeek prompt', () => {
  for (const scenario of ['Codex-only', 'Kimi-only', 'no credentials']) {
    const state = runInitialScenario(false);
    assert.equal(state.mainCreates, 1, `${scenario} must create the main window`);
    assert.equal(state.loginCreates, 1, `${scenario} may show the optional DeepSeek prompt`);
    assert.equal(state.result, state.main);
  }

  const deepseekConfigured = runInitialScenario(true);
  assert.equal(deepseekConfigured.mainCreates, 1);
  assert.equal(deepseekConfigured.loginCreates, 0);
});

test('skipping DeepSeek closes only the prompt and shows or creates the main window', () => {
  const { skipDeepseekLogin } = loadPolicy();
  const existingMain = makeWindow();
  const login = makeWindow();
  let creates = 0;

  const shown = skipDeepseekLogin({
    getMainWindow: () => existingMain,
    getLoginWindow: () => login,
    createMainWindow() { creates += 1; }
  });

  assert.equal(login.closed, true);
  assert.equal(existingMain.shown, true);
  assert.equal(creates, 0);
  assert.equal(shown, existingMain);

  let createdMain = null;
  const created = skipDeepseekLogin({
    getMainWindow: () => createdMain,
    getLoginWindow: () => null,
    createMainWindow() { createdMain = makeWindow(); }
  });

  assert.equal(createdMain.shown, true);
  assert.equal(created, createdMain);
});

test('later DeepSeek login runs completion immediately for an existing main window and waits for a newly created one', () => {
  const { runWhenMainWindowReady } = loadPolicy();
  let immediate = 0;
  const existing = {
    webContents: {
      once() { throw new Error('an existing loaded window must not wait for another load event'); }
    }
  };
  runWhenMainWindowReady(existing, false, () => { immediate += 1; });
  assert.equal(immediate, 1);

  let listener = null;
  let delayed = 0;
  const created = {
    webContents: {
      once(channel, callback) {
        assert.equal(channel, 'did-finish-load');
        listener = callback;
      }
    }
  };
  runWhenMainWindowReady(created, true, () => { delayed += 1; });
  assert.equal(delayed, 0);
  listener();
  assert.equal(delayed, 1);
});

test('login skip uses a dedicated allow-listed IPC path and main-process policy', () => {
  const loginSource = read('src/renderer/js/login.js');
  const preloadSource = read('src/preload/preload.js');
  const ipcSource = read('src/main/ipc.js');

  assert.match(loginSource, /skipBtn\.addEventListener[\s\S]*send\('login:skip'\)/);
  assert.doesNotMatch(
    loginSource.match(/skipBtn\.addEventListener[\s\S]*?\n\}\);/)?.[0] || '',
    /window:close/
  );
  assert.match(preloadSource, /'login:skip'/);
  assert.match(ipcSource, /require\('\.\/core\/startup-windows'\)/);
  assert.match(ipcSource, /ipcMain\.on\('login:skip',[\s\S]*skipDeepseekLogin/);
});

test('initial startup creates and initializes the main window before any DeepSeek-only work', () => {
  const source = read('src/main/index.js');
  const importIndex = source.indexOf("require('./core/startup-windows')");
  const openIndex = source.indexOf('openInitialWindows({');
  const loadIndex = source.indexOf("mainWindow.webContents.on('did-finish-load'");
  const missingKeyIndex = source.indexOf('if (!apiKey)');

  assert.ok(importIndex >= 0, 'index must import the startup window policy');
  assert.ok(openIndex > importIndex, 'initial windows must use the policy');
  assert.ok(loadIndex > openIndex, 'the main window must exist before its load handler is attached');
  assert.ok(missingKeyIndex > loadIndex, 'settings and provider UI initialization must not be gated by a DeepSeek key');
  assert.doesNotMatch(source, /else\s*\{\s*createLoginWindow\(\);\s*\}/);
});
