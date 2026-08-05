const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const modulePath = path.join(root, 'src', 'main', 'core', 'provider-startup.js');

function loadStartupPolicy() {
  assert.equal(fs.existsSync(modulePath), true, 'provider startup policy module must exist');
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('initial startup opens the main window for DeepSeek, Codex-only, or Kimi-only users', () => {
  const { chooseInitialWindow } = loadStartupPolicy();

  assert.equal(chooseInitialWindow({
    deepseekApiKey: 'sk-present',
    providerSnapshot: []
  }), 'main');

  assert.equal(chooseInitialWindow({
    deepseekApiKey: null,
    providerSnapshot: [
      { id: 'deepseek', authStatus: 'missing' },
      { id: 'codex', authStatus: 'ok' },
      { id: 'kimi', authStatus: 'missing' }
    ]
  }), 'main');

  assert.equal(chooseInitialWindow({
    deepseekApiKey: null,
    providerSnapshot: [
      { id: 'deepseek', authStatus: 'missing' },
      { id: 'codex', authStatus: 'missing' },
      { id: 'kimi', authStatus: 'ok' }
    ]
  }), 'main');
});

test('all-missing startup keeps the onboarding window until the user explicitly skips', () => {
  const { chooseInitialWindow } = loadStartupPolicy();
  assert.equal(chooseInitialWindow({
    deepseekApiKey: '',
    providerSnapshot: [
      { id: 'deepseek', authStatus: 'missing' },
      { id: 'codex', authStatus: 'missing' },
      { id: 'kimi', authStatus: 'missing' }
    ]
  }), 'login');
});

test('skipping DeepSeek creates and shows the main window before closing the only login window', () => {
  const { continueWithoutDeepseek } = loadStartupPolicy();
  const events = [];
  let mainWindow = null;
  const loginWindow = {
    isDestroyed: () => false,
    close() { events.push('close-login'); }
  };

  const result = continueWithoutDeepseek({
    getMainWindow: () => mainWindow,
    getLoginWindow: () => loginWindow,
    createMainWindow() {
      events.push('create-main');
      mainWindow = {
        isDestroyed: () => false,
        show() { events.push('show-main'); }
      };
    }
  });

  assert.equal(result, mainWindow);
  assert.deepEqual(events, ['create-main', 'show-main', 'close-login']);
});

test('skip reuses an existing main window instead of creating a duplicate', () => {
  const { continueWithoutDeepseek } = loadStartupPolicy();
  const events = [];
  const mainWindow = {
    isDestroyed: () => false,
    show() { events.push('show-main'); }
  };
  const loginWindow = {
    isDestroyed: () => false,
    close() { events.push('close-login'); }
  };

  const result = continueWithoutDeepseek({
    getMainWindow: () => mainWindow,
    getLoginWindow: () => loginWindow,
    createMainWindow() { events.push('unexpected-create'); }
  });

  assert.equal(result, mainWindow);
  assert.deepEqual(events, ['show-main', 'close-login']);
});

test('main renderer initializes without DeepSeek network work when the API key is absent', () => {
  const { initializeMainRenderer } = loadStartupPolicy();
  const sent = [];
  const polls = [];
  const events = [];
  const runtime = {};
  const settings = { window: { darkMode: 'system' } };

  const result = initializeMainRenderer({
    mainWindow: {
      webContents: {
        isDestroyed: () => false,
        send(channel, payload) { sent.push({ channel, payload }); }
      }
    },
    store: {
      store: settings,
      get(key) {
        if (key === 'providers.deepseek.apiKey') return null;
        if (key === 'providers.deepseek.sessionToken') return null;
        return undefined;
      }
    },
    sanitizeSettings: (value) => value,
    scheduler: { poll(provider, channel) { polls.push(`${provider}:${channel}`); } },
    runtime,
    restoreSession() { events.push('restore-session'); },
    getSessionSnapshot: () => ({ loggedIn: false }),
    clearSession(target, message) {
      target.sessionStatus = 'missing';
      target.sessionError = message;
      events.push('clear-session');
    },
    createSessionWindow() { events.push('create-session-window'); },
    broadcastSessionState() { events.push('broadcast-session'); },
    updateTrayMenu() { events.push('update-tray'); },
    now: () => 123
  });

  assert.equal(result.mode, 'without-deepseek');
  assert.deepEqual(sent, [{ channel: 'settings:loaded', payload: settings }]);
  assert.deepEqual(polls, []);
  assert.equal(events.includes('create-session-window'), false);
  assert.match(runtime.sessionError, /DeepSeek/);
  assert.match(runtime.sessionError, /设置/);
  assert.deepEqual(runtime.proxyStatus, {
    running: false,
    port: 0,
    error: runtime.sessionError
  });
  assert.deepEqual(events.slice(-2), ['broadcast-session', 'update-tray']);
});

test('configured DeepSeek startup preserves balance and stored-session initialization', () => {
  const { initializeMainRenderer } = loadStartupPolicy();
  const polls = [];
  const events = [];
  const runtime = {};

  const result = initializeMainRenderer({
    mainWindow: {
      webContents: {
        isDestroyed: () => false,
        send() {}
      }
    },
    store: {
      store: {},
      get(key) {
        if (key === 'providers.deepseek.apiKey') return 'sk-present';
        if (key === 'providers.deepseek.sessionToken') return 'stored-token';
        return undefined;
      }
    },
    sanitizeSettings: (value) => value,
    scheduler: { poll(provider, channel) { polls.push(`${provider}:${channel}`); } },
    runtime,
    restoreSession(target, token) {
      target.sessionStatus = token === 'stored-token' ? 'valid' : 'missing';
      events.push('restore-session');
    },
    getSessionSnapshot: (target) => ({ loggedIn: target.sessionStatus === 'valid' }),
    clearSession() { events.push('clear-session'); },
    createSessionWindow() { events.push('create-session-window'); },
    broadcastSessionState() { events.push('broadcast-session'); },
    updateTrayMenu() { events.push('update-tray'); },
    now: () => 456
  });

  assert.equal(result.mode, 'deepseek-ready');
  assert.deepEqual(polls, ['deepseek:balance', 'deepseek:usage']);
  assert.equal(events.includes('create-session-window'), false);
  assert.deepEqual(runtime.proxyStatus, { running: true, port: 0, activeSince: 456 });
});

test('login, preload, IPC, and main startup use the dedicated provider-independent flow', () => {
  const login = read('src/renderer/js/login.js');
  const preload = read('src/preload/preload.js');
  const ipc = read('src/main/ipc.js');
  const main = read('src/main/index.js');

  assert.match(login, /skipBtn[\s\S]*window\.api\.send\('login:skip'\)/);
  assert.doesNotMatch(login, /skipBtn[\s\S]*window\.api\.send\('window:close'\)/);
  assert.match(preload, /'login:skip'/);
  assert.match(ipc, /ipcMain\.on\('login:skip'[\s\S]*deps\.continueWithoutDeepseek\(\)/);
  assert.match(main, /chooseInitialWindow\([\s\S]*providerSnapshot:\s*scheduler\.getSnapshot\(\)/);
  assert.match(main, /initializeMainRenderer\(/);
  assert.match(main, /continueWithoutDeepseek/);
});
