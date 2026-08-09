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
    'diagnostics:copy-report', 'diagnostics:open-guide', 'diagnostics:run'
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

test('main creates, reuses, broadcasts to, and disposes the diagnostics window by captured webContents id', async (t) => {
  const originalLoad = Module._load;
  const originalSetTimeout = global.setTimeout;
  const windows = [];
  const sequence = [];
  const appListeners = new Map();
  let nativeThemeUpdated;
  let setupDependencies;
  let diagnosticsDependencies;
  const disposed = [];

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
    store: {},
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
        'providers.proxyUrl': ''
      };
      return values[key];
    },
    set() {}, delete() {}, sanitizeSettings: () => ({}), migrateLegacyKeys() {}
  };
  const fakeDiagnostics = { dispose: (id) => disposed.push(id) };
  const fakeScheduler = { stop() {}, getSnapshot: () => [], getState: () => null };

  Module._load = function (request, parent, isMain) {
    const parentFile = parent && parent.filename || '';
    if (request === 'electron') return fakeElectron;
    if (parentFile.endsWith(path.join('src', 'main', 'index.js'))) {
      if (request === './store') return store;
      if (request === './providers/registry') return { register() {}, list: () => [] };
      if (request === './providers/deepseek' || request === './providers/codex' || request === './providers/kimi') return {};
      if (request === './core/scheduler') return {
        startScheduler() { sequence.push('scheduler'); return fakeScheduler; }
      };
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
  assert.deepEqual(sequence.slice(0, 3), ['scheduler', 'diagnostics', 'ipc']);
  assert.equal(setupDependencies.diagnostics, fakeDiagnostics);
  assert.equal(typeof setupDependencies.createDiagnosticsWindow, 'function');
  assert.equal(typeof setupDependencies.getDiagnosticsWindow, 'function');
  assert.equal(diagnosticsDependencies.scheduler, fakeScheduler);

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
  assert.match(diagnosticsWindow.loadedFile, /src[\\/]renderer[\\/]diagnostics-window\.html$/);

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
