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
    focused: false,
    shown: false,
    close() { this.closed = true; },
    focus() { this.focused = true; },
    isDestroyed() { return this.destroyed; },
    show() { this.shown = true; }
  };
}

test('Codex-only, Kimi-only, and no-credential users can skip DeepSeek into a new main window', () => {
  const { skipDeepseekLogin } = loadPolicy();

  for (const scenario of ['Codex-only', 'Kimi-only', 'no credentials']) {
    const login = makeWindow();
    let main = null;
    let creates = 0;

    const result = skipDeepseekLogin({
      getLoginWindow: () => login,
      getMainWindow: () => main,
      createMainWindow() {
        creates += 1;
        main = makeWindow();
      }
    });

    assert.equal(login.closed, true, `${scenario} must close only the optional prompt`);
    assert.equal(creates, 1, `${scenario} must create the main window`);
    assert.equal(main.shown, true, `${scenario} must show the main window`);
    assert.equal(main.focused, true, `${scenario} must focus the main window`);
    assert.equal(result, main);
  }
});

test('skipping DeepSeek reuses an existing main window without creating a duplicate', () => {
  const { skipDeepseekLogin } = loadPolicy();
  const login = makeWindow();
  const main = makeWindow();
  let creates = 0;

  const result = skipDeepseekLogin({
    getLoginWindow: () => login,
    getMainWindow: () => main,
    createMainWindow() { creates += 1; }
  });

  assert.equal(login.closed, true);
  assert.equal(creates, 0);
  assert.equal(main.shown, true);
  assert.equal(main.focused, true);
  assert.equal(result, main);
});

test('skipping DeepSeek replaces a destroyed main window before showing it', () => {
  const { skipDeepseekLogin } = loadPolicy();
  const destroyed = makeWindow();
  destroyed.destroyed = true;
  let main = destroyed;
  let creates = 0;

  const result = skipDeepseekLogin({
    getLoginWindow: () => null,
    getMainWindow: () => main,
    createMainWindow() {
      creates += 1;
      main = makeWindow();
    }
  });

  assert.equal(creates, 1);
  assert.notEqual(result, destroyed);
  assert.equal(result.shown, true);
  assert.equal(result.focused, true);
});

test('login skip uses a dedicated allow-listed IPC path and delegates to the window policy', () => {
  const loginSource = read('src/renderer/js/login.js');
  const preloadSource = read('src/preload/preload.js');
  const ipcSource = read('src/main/ipc.js');

  const skipHandler = loginSource.match(/skipBtn\.addEventListener[\s\S]*?\n\}\);/)?.[0] || '';
  assert.match(skipHandler, /send\('login:skip'\)/);
  assert.doesNotMatch(skipHandler, /window:close/);
  assert.match(preloadSource, /'login:skip'/);
  assert.match(ipcSource, /require\('\.\/core\/startup-windows'\)/);
  assert.match(ipcSource, /ipcMain\.on\('login:skip',[\s\S]*skipDeepseekLogin/);
});
