const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const { registerDiagnosticsIpc } = require('../src/main/core/diagnostics/ipc-registration');

function fakeIpcMain() {
  const on = new Map();
  const handle = new Map();
  return {
    on,
    handle,
    api: {
      on(channel, callback) {
        if (on.has(channel)) throw new Error('duplicate on');
        on.set(channel, callback);
      },
      handle(channel, callback) {
        if (handle.has(channel)) throw new Error('duplicate handle');
        handle.set(channel, callback);
      },
      removeListener(channel, callback) {
        if (on.get(channel) === callback) on.delete(channel);
      },
      removeHandler(channel) {
        handle.delete(channel);
      }
    }
  };
}

function fakeWindow(id) {
  let destroyed = false;
  let closed = 0;
  const webContents = { id, isDestroyed: () => destroyed };
  return {
    webContents,
    isDestroyed: () => destroyed,
    close() { closed += 1; destroyed = true; },
    closed: () => closed
  };
}

test('theme projection reads only own data properties and returns the exact safe shape', () => {
  const { projectDiagnosticsTheme } = require('../src/main/core/diagnostics/theme');
  const projected = projectDiagnosticsTheme({
    window: { darkMode: 'acrylic-dark', followSystemTheme: false, alwaysOnTop: true },
    providers: { codex: { localLogRoot: 'C:\\Users\\Alice\\.codex' } },
    localLogCursors: { 'C:\\Users\\Alice\\.codex\\sessions\\rollout.jsonl': 99 },
    mcp: { token: 'mcp-private' }
  });
  assert.deepEqual(projected, {
    window: { darkMode: 'acrylic-dark', followSystemTheme: false }
  });
  assert.doesNotMatch(JSON.stringify(projected), /Alice|rollout|mcp-private|alwaysOnTop/);

  let getterTouches = 0;
  const hostileWindow = {};
  Object.defineProperties(hostileWindow, {
    darkMode: { enumerable: true, get() { getterTouches += 1; return 'dark'; } },
    followSystemTheme: { enumerable: true, get() { getterTouches += 1; return false; } }
  });
  const hostileSettings = {};
  Object.defineProperty(hostileSettings, 'window', {
    enumerable: true,
    get() { getterTouches += 1; return hostileWindow; }
  });
  assert.deepEqual(projectDiagnosticsTheme(hostileSettings), {
    window: { darkMode: 'system', followSystemTheme: true }
  });
  assert.equal(getterTouches, 0);
  assert.deepEqual(projectDiagnosticsTheme({ window: { darkMode: 'invalid', followSystemTheme: 'false' } }), {
    window: { darkMode: 'system', followSystemTheme: true }
  });
});

test('theme IPC authorizes only the exact active diagnostics webContents', async () => {
  const ipc = fakeIpcMain();
  const active = fakeWindow(78);
  const themeProjection = { window: { darkMode: 'dark', followSystemTheme: false } };
  registerDiagnosticsIpc({
    ipcMain: ipc.api,
    diagnostics: { start() {}, copy() {}, openGuide() {} },
    getDiagnosticsWindow: () => active,
    createDiagnosticsWindow() {},
    getDiagnosticsTheme: () => themeProjection
  });

  assert.deepEqual(await ipc.handle.get('diagnostics:get-theme')({ sender: active.webContents }), themeProjection);
  for (const sender of [
    { id: 78, isDestroyed: () => false },
    { id: 1, isDestroyed: () => false }
  ]) {
    assert.deepEqual(await ipc.handle.get('diagnostics:get-theme')({ sender }), {
      ok: false,
      errorCode: 'DIAGNOSTICS_SENDER_INVALID'
    });
  }
});

test('IPC routes only the exact active diagnostics webContents and remains stable on repeats and failures', async () => {
  const ipc = fakeIpcMain();
  const calls = [];
  let creates = 0;
  let active = fakeWindow(77);
  const diagnostics = {
    start(sender) { calls.push(['run', sender]); return { runId: 'run-77', checks: [] }; },
    copy(sender, runId) { calls.push(['copy', sender, runId]); return { ok: true, length: 8 }; },
    openGuide(sender, guideId) { calls.push(['guide', sender, guideId]); return { ok: true }; }
  };
  const dependencies = {
    ipcMain: ipc.api,
    diagnostics,
    getDiagnosticsWindow: () => active,
    createDiagnosticsWindow: () => { creates += 1; }
  };

  assert.equal(registerDiagnosticsIpc(dependencies), true);
  assert.equal(registerDiagnosticsIpc(dependencies), false);
  assert.deepEqual([...ipc.on.keys()].sort(), ['open:diagnostics', 'window:close-diagnostics']);
  assert.deepEqual([...ipc.handle.keys()].sort(), [
    'diagnostics:copy-report', 'diagnostics:get-theme', 'diagnostics:open-guide', 'diagnostics:run'
  ]);

  ipc.on.get('open:diagnostics')({ sender: { id: 1 } });
  assert.equal(creates, 1);

  const validEvent = { sender: active.webContents };
  assert.deepEqual(await ipc.handle.get('diagnostics:run')(validEvent), { runId: 'run-77', checks: [] });
  assert.deepEqual(await ipc.handle.get('diagnostics:copy-report')(validEvent, 'run-77'), { ok: true, length: 8 });
  assert.deepEqual(await ipc.handle.get('diagnostics:open-guide')(validEvent, 'app-runtime'), { ok: true });
  assert.deepEqual(calls.map((call) => call[0]), ['run', 'copy', 'guide']);

  for (const sender of [
    { id: 77, isDestroyed: () => false },
    { id: 1, isDestroyed: () => false },
    active.webContents
  ]) {
    if (sender === active.webContents) active = fakeWindow(88);
    const invalidEvent = { sender };
    assert.deepEqual(await ipc.handle.get('diagnostics:run')(invalidEvent), {
      ok: false,
      errorCode: 'DIAGNOSTICS_SENDER_INVALID'
    });
    assert.deepEqual(await ipc.handle.get('diagnostics:copy-report')(invalidEvent, 'run-77'), {
      ok: false,
      errorCode: 'DIAGNOSTICS_SENDER_INVALID'
    });
    assert.deepEqual(await ipc.handle.get('diagnostics:open-guide')(invalidEvent, 'app-runtime'), {
      ok: false,
      errorCode: 'DIAGNOSTICS_SENDER_INVALID'
    });
  }
  assert.deepEqual(calls.map((call) => call[0]), ['run', 'copy', 'guide']);

  const wrong = fakeWindow(99);
  ipc.on.get('window:close-diagnostics')({ sender: wrong.webContents });
  assert.equal(active.closed(), 0);
  ipc.on.get('window:close-diagnostics')({ sender: active.webContents });
  assert.equal(active.closed(), 1);

  active = fakeWindow(100);
  diagnostics.start = () => { throw new Error('raw sync secret'); };
  assert.deepEqual(await ipc.handle.get('diagnostics:run')({ sender: active.webContents }), {
    ok: false,
    errorCode: 'DIAGNOSTICS_RUN_FAILED'
  });
  diagnostics.copy = () => Promise.reject(new Error('raw async secret'));
  assert.deepEqual(await ipc.handle.get('diagnostics:copy-report')({ sender: active.webContents }, 'x'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_COPY_FAILED'
  });
  diagnostics.openGuide = () => Promise.reject(new Error('raw guide secret'));
  assert.deepEqual(await ipc.handle.get('diagnostics:open-guide')({ sender: active.webContents }, 'app-runtime'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_GUIDE_FAILED'
  });
});

test('IPC registration rolls back partial listeners atomically and can retry after a registration failure', () => {
  const on = new Map();
  const handle = new Map();
  const removed = [];
  let registrationCall = 0;
  let failAt = 3;
  const ipcMain = {
    on(channel, callback) {
      registrationCall += 1;
      if (registrationCall === failAt) throw new Error('registration failed');
      on.set(channel, callback);
    },
    handle(channel, callback) {
      registrationCall += 1;
      if (registrationCall === failAt) throw new Error('registration failed');
      handle.set(channel, callback);
    },
    removeListener(channel, callback) {
      removed.push(['on', channel]);
      if (on.get(channel) === callback) on.delete(channel);
    },
    removeHandler(channel) {
      removed.push(['handle', channel]);
      handle.delete(channel);
    }
  };
  const dependencies = {
    ipcMain,
    diagnostics: { start() {}, copy() {}, openGuide() {} },
    getDiagnosticsWindow: () => null,
    createDiagnosticsWindow() {}
  };

  assert.throws(() => registerDiagnosticsIpc(dependencies), /registration failed/);
  assert.deepEqual([...on.keys()], []);
  assert.deepEqual([...handle.keys()], []);
  assert.deepEqual(removed, [
    ['on', 'window:close-diagnostics'],
    ['on', 'open:diagnostics']
  ]);

  registrationCall = 0;
  failAt = -1;
  assert.equal(registerDiagnosticsIpc(dependencies), true);
  assert.deepEqual([...on.keys()].sort(), ['open:diagnostics', 'window:close-diagnostics']);
  assert.deepEqual([...handle.keys()].sort(), [
    'diagnostics:copy-report', 'diagnostics:get-theme', 'diagnostics:open-guide', 'diagnostics:run'
  ]);
  assert.equal(registerDiagnosticsIpc(dependencies), false);
});

test('IPC registration rejects missing rollback APIs before registering any channel and remains retryable', () => {
  const registrations = [];
  const ipcMain = {
    on(channel) { registrations.push(['on', channel]); },
    handle(channel) { registrations.push(['handle', channel]); }
  };
  const dependencies = {
    ipcMain,
    diagnostics: { start() {}, copy() {}, openGuide() {} },
    getDiagnosticsWindow: () => null,
    createDiagnosticsWindow() {}
  };

  assert.throws(() => registerDiagnosticsIpc(dependencies), TypeError);
  assert.deepEqual(registrations, []);

  ipcMain.removeListener = () => {};
  ipcMain.removeHandler = () => {};
  assert.equal(registerDiagnosticsIpc(dependencies), true);
  assert.equal(registrations.length, 6);
  assert.equal(registerDiagnosticsIpc(dependencies), false);
});

test('main creates, reuses, broadcasts to, and disposes the diagnostics window by captured webContents id', async (t) => {
  const originalLoad = Module._load;
  const originalSetTimeout = global.setTimeout;
  const windows = [];
  const sequence = [];
  const appListeners = new Map();
  let nativeThemeUpdated;
  let setupDependencies;
  let diagnosticsDependencies;
  let schedulerDependencies;
  let storedProxyValue = '';
  const resolvedTargets = [];
  const disposed = [];
  const realProxySettings = require('../src/main/core/proxy-settings');
  const injectedSystemResolver = async (targetUrl) => {
    resolvedTargets.push(targetUrl);
    return 'http://system.proxy:8080';
  };

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.webContentsDestroyed = false;
      this.visible = false;
      this.focused = 0;
      this.events = new Map();
      this.messages = [];
      const webContents = {
        id: 500 + windows.length,
        isDestroyed: () => this.webContentsDestroyed,
        send: (channel, payload) => {
          if (this.webContentsDestroyed) throw new Error('destroyed webContents send');
          this.messages.push({ channel, payload });
        },
        on: () => {},
        setZoomFactor: () => {}
      };
      Object.defineProperty(this, 'webContents', {
        get: () => {
          if (this.destroyed) throw new Error('destroyed webContents accessed');
          return webContents;
        }
      });
      this.webContentsId = webContents.id;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    show() { this.visible = true; }
    focus() { this.focused += 1; }
    hide() { this.visible = false; }
    getBounds() { return { x: 0, y: 0, width: this.options.width || 420, height: this.options.height || 680 }; }
    getPosition() { return [0, 0]; }
    setAlwaysOnTop() {}
    close() { this.destroyed = true; this.emit('closed'); }
    destroy() { this.destroyed = true; }
    setMenu() {}
    setBackgroundMaterial() {}
    loadFile(file) { this.loadedFile = file; }
    on(event, listener) { this.events.set(event, listener); }
    once(event, listener) { this.events.set(event, listener); }
    emit(event, ...args) { const listener = this.events.get(event); if (listener) listener(...args); }
  }

  const fakeElectron = {
    app: {
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      on: (event, listener) => appListeners.set(event, listener),
      quit() {},
      setLoginItemSettings() {},
      getVersion: () => '1.0.0',
      getPath: () => 'C:\\userdata',
      getAppPath: () => 'C:\\app',
      isPackaged: false
    },
    BrowserWindow: FakeBrowserWindow,
    Tray: class { setToolTip() {} on() {} setContextMenu() {} destroy() {} },
    Menu: { buildFromTemplate: () => ({}) },
    nativeTheme: {
      shouldUseDarkColors: false,
      on(event, listener) { if (event === 'updated') nativeThemeUpdated = listener; }
    },
    clipboard: { writeText() {} },
    shell: { openPath: async () => '' }
  };
  const store = {
    store: {
      window: { darkMode: 'acrylic-dark', followSystemTheme: false, alwaysOnTop: true },
      providers: { codex: { localLogRoot: 'C:\\Users\\Alice\\.codex' } },
      localLogCursors: { 'C:\\Users\\Alice\\.codex\\sessions\\rollout.jsonl': 99 },
      mcp: { token: 'mcp-private' }
    },
    get(key) {
      const values = {
        window: { x: 0, y: 0, width: 420, height: 680 },
        'window.alwaysOnTop': true,
        'window.zoomFactor': 1,
        'window.autoLaunch': false,
        'window.followSystemTheme': true,
        'window.darkMode': 'system',
        'providers.deepseek.apiKey': 'configured',
        'data.historyDays': 7,
        'providers.proxyUrl': storedProxyValue
      };
      return values[key];
    },
    set() {}, delete() {}, sanitizeSettings: () => ({}), migrateLegacyKeys() {}
  };
  const fakeDiagnostics = { dispose: (id) => disposed.push(id) };
  const fakeScheduler = { stop() {}, getSnapshot: () => [], getState: () => null };
  const fakeTokenSpeedRuntime = {
    start() { sequence.push('token-speed'); },
    stop() {},
    applySettings() {},
    rebaselineAll() {},
    observeProvider() {},
    markProviderUnavailable() {}
  };
  const fakeMcpRuntime = {
    start() { sequence.push('mcp'); },
    stop() {},
    isRunning: () => false,
    getConnectionInfo: () => ({ enabled: false, url: null, token: null }),
    rotateToken: () => ({ enabled: false, url: null, token: null })
  };

  Module._load = function (request, parent, isMain) {
    const parentFile = parent && parent.filename || '';
    if (request === 'electron') return fakeElectron;
    if (parentFile.endsWith(path.join('src', 'main', 'index.js'))) {
      if (request === './store') return store;
      if (request === './providers/registry') return { register() {}, list: () => [] };
      if (request === './providers/deepseek' || request === './providers/kimi') return {};
      if (request === './providers/codex') return {
        createCodexUsageRuntime() {
          return {
            startMigration() { return Promise.resolve({ migrated: true, skipped: false, summary: null }); },
            stop() {},
            rebuild() { return Promise.resolve({}); },
            runIncremental(fn) { return fn({ mode: 'uuid' }); },
            getStatus() { return { phase: 'ready', migrationPending: false, compatibilityMode: false, lastErrorCode: null }; }
          };
        },
        localLogRoot() { return 'C:\\Users\\Alice\\.codex'; },
        archivedLogRoot() { return 'C:\\Users\\Alice\\.codex\\archived_sessions'; },
        readLocalLog: async () => ({ records: [], complete: true, bytesRead: 0 })
      };
      if (request === './core/scheduler') return {
        startScheduler(dependencies) {
          sequence.push('scheduler');
          schedulerDependencies = dependencies;
          return fakeScheduler;
        }
      };
      if (request === './core/token-speed-runtime') return {
        createTokenSpeedRuntime: () => fakeTokenSpeedRuntime
      };
      if (request === './mcp') return {
        startMCP: () => fakeMcpRuntime
      };
      if (request === './core/proxy-settings') return Object.assign({}, realProxySettings, {
        resolveElectronSystemProxy: injectedSystemResolver
      });
      if (request === './core/diagnostics') return {
        createDiagnostics(dependencies) {
          sequence.push('diagnostics');
          diagnosticsDependencies = dependencies;
          return fakeDiagnostics;
        }
      };
      if (request === './ipc') return (dependencies) => {
        sequence.push('ipc');
        setupDependencies = dependencies;
      };
      if (request === './windows-backdrop') return {
        isAcrylicTheme: () => false,
        tintForTheme: () => null,
        isAccentSupported: () => false,
        applyAccent: () => false,
        clearAccent: () => true
      };
    }
    return originalLoad(request, parent, isMain);
  };
  global.setTimeout = () => ({ unref() {} });
  const mainPath = require.resolve('../src/main/index.js');
  delete require.cache[mainPath];
  t.after(() => {
    Module._load = originalLoad;
    global.setTimeout = originalSetTimeout;
    delete require.cache[mainPath];
  });

  require(mainPath);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sequence.slice(0, 5), ['scheduler', 'token-speed', 'diagnostics', 'mcp', 'ipc']);
  assert.equal(setupDependencies.diagnostics, fakeDiagnostics);
  assert.equal(setupDependencies.tokenSpeedRuntime, fakeTokenSpeedRuntime);
  assert.equal(setupDependencies.getMcpRuntime(), fakeMcpRuntime);
  assert.equal(typeof setupDependencies.createDiagnosticsWindow, 'function');
  assert.equal(typeof setupDependencies.getDiagnosticsWindow, 'function');
  assert.deepEqual(setupDependencies.getDiagnosticsTheme(), {
    window: { darkMode: 'acrylic-dark', followSystemTheme: false }
  });
  assert.equal(diagnosticsDependencies.scheduler, fakeScheduler);
  assert.equal(diagnosticsDependencies.providers.getProxyUrl, schedulerDependencies.getProxyInput);
  assert.equal(diagnosticsDependencies.providers.getProxyUrl(), null);
  storedProxyValue = 'http://proxy.example:7890';
  assert.equal(diagnosticsDependencies.providers.getProxyUrl(), 'http://proxy.example:7890');
  storedProxyValue = 'system';
  const systemProxy = diagnosticsDependencies.providers.getProxyUrl();
  assert.equal(typeof systemProxy, 'function');
  assert.equal(await systemProxy('https://target.example/path'), 'http://system.proxy:8080');
  assert.deepEqual(resolvedTargets, ['https://target.example/path']);

  const before = windows.length;
  setupDependencies.createDiagnosticsWindow();
  const diagnosticsWindow = windows[before];
  assert.equal(diagnosticsWindow.options.width, 720);
  assert.equal(diagnosticsWindow.options.height, 640);
  assert.equal(diagnosticsWindow.options.minWidth, 560);
  assert.equal(diagnosticsWindow.options.minHeight, 440);
  assert.equal(diagnosticsWindow.options.resizable, true);
  assert.equal(diagnosticsWindow.options.show, false);
  assert.equal(diagnosticsWindow.options.roundedCorners, true);
  assert.equal(diagnosticsWindow.options.webPreferences.contextIsolation, true);
  assert.equal(diagnosticsWindow.options.webPreferences.nodeIntegration, false);
  assert.match(diagnosticsWindow.options.webPreferences.preload, /src[\\/]preload[\\/]diagnostics-preload\.js$/);
  assert.match(diagnosticsWindow.loadedFile, /src[\\/]renderer[\\/]diagnostics-window\.html$/);

  setupDependencies.broadcastSettings();
  assert.equal(diagnosticsWindow.messages.some((message) => message.channel === 'settings:loaded'), false);

  setupDependencies.createDiagnosticsWindow();
  assert.equal(windows.length, before + 1);
  assert.equal(diagnosticsWindow.visible, true);
  assert.equal(diagnosticsWindow.focused, 1);

  setupDependencies.applySetting('window.darkMode', 'dark');
  assert.ok(diagnosticsWindow.messages.some((message) => message.channel === 'theme:changed'));
  diagnosticsWindow.emit('blur');
  diagnosticsWindow.emit('focus');
  assert.deepEqual(
    diagnosticsWindow.messages.filter((message) => message.channel === 'window:focus-state').map((message) => message.payload),
    [false, true]
  );
  diagnosticsWindow.webContentsDestroyed = true;
  assert.doesNotThrow(() => diagnosticsWindow.emit('blur'));
  diagnosticsWindow.webContentsDestroyed = false;
  assert.equal(typeof nativeThemeUpdated, 'function');

  const capturedId = diagnosticsWindow.webContentsId;
  assert.doesNotThrow(() => diagnosticsWindow.close());
  assert.deepEqual(disposed, [capturedId]);
  assert.equal(setupDependencies.getDiagnosticsWindow(), null);
});
