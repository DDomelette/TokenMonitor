const { app, BrowserWindow, Tray, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { migrateLegacyKeys } = store;
const registry = require('./providers/registry');
const deepseekProvider = require('./providers/deepseek');
const codexProvider = require('./providers/codex');
const kimiProvider = require('./providers/kimi');
const { startScheduler } = require('./core/scheduler');
const setupIPC = require('./ipc');
const { captureSession } = require('./providers/deepseek/session');

let mainWindow = null;
let loginWindow = null;
let sessionWindow = null;
let settingsWindow = null;
let tray = null;
let scheduler = null;
let moveDebounce = null;

const runtime = {
  sessionToken: null,
  proxyStatus: { running: false, port: 0, error: '未获取数据' }
};

// 缩放状态机运行标记(状态本体在 ipc.js,这里只消费布尔值)
const resizeState = { main: false, settings: false };

// 主窗口加载 Vite 构建产物(renderer/dist),构建前需先运行 npm run build:renderer。
function loadRenderer(win) {
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'dist', 'index.html'));
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return;
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

function getWinBounds() {
  const win = store.get('window');
  return {
    x: win.x,
    y: win.y,
    width: win.width || 420,
    height: win.height || 680
  };
}

function sendMainWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;
  if (resizeState.main) return;
  mainWindow.webContents.send('window:bounds-changed', mainWindow.getBounds());
}

function broadcastToWindows(channel, payload) {
  [mainWindow, settingsWindow].forEach(function (win) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  });
}

function broadcastSettings() {
  broadcastToWindows('settings:loaded', store.sanitizeSettings(store.store));
}

function broadcastSessionState() {
  var payload = { loggedIn: !!runtime.sessionToken, error: runtime.proxyStatus.error || null };
  broadcastToWindows('session:changed', payload);
}

function createMainWindow() {
  const bounds = getWinBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    // 非透明窗口:缩放无分层窗口帧竞态;圆角交给 Win11 DWM 合成层裁剪(与 VSCode 同一方案)
    transparent: false,
    backgroundColor: '#00000000',
    roundedCorners: true,
    // DWM 磨砂透明:替代整窗 setOpacity(分层窗口缩放会露黑边)
    backgroundMaterial: 'acrylic',
    alwaysOnTop: store.get('window.alwaysOnTop'),
    // 原生缩放:Chromium 在系统缩放循环中拉伸旧帧,不会露出黑色欠采样区(同 VSCode)
    resizable: true,
    minWidth: 380,
    minHeight: 200,
    maxWidth: 2400,
    maxHeight: 1600,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 整窗透明度已由 backgroundMaterial:'acrylic' 的 DWM 磨砂取代。
  // 禁用 setOpacity:它会加 WS_EX_LAYERED,分层窗口缩放时新区域被清成透明黑,
  // 整窗统一 alpha 混合后显示为黑边。
  loadRenderer(mainWindow);

  // 渲染进程异常诊断:加载失败/进程崩溃时写入日志
  mainWindow.webContents.on('console-message', function (e, level, message) {
    if (level >= 2) console.error('[renderer:console]', level, message);
  });
  mainWindow.webContents.on('did-fail-load', function (e, code, desc) {
    console.error('[renderer:did-fail-load]', code, desc);
  });
  mainWindow.webContents.on('render-process-gone', function (e, details) {
    console.error('[renderer:gone]', JSON.stringify(details));
  });

  mainWindow.webContents.on('did-finish-load', function () {
    mainWindow.webContents.setZoomFactor(store.get('window.zoomFactor') || 1);
  });

  mainWindow.on('close', function (e) {
    if (!app.isQuitting) {
      mainWindow.hide();
      e.preventDefault();
    }
  });

  mainWindow.on('move', function () {
    if (resizeState.main) return;
    sendMainWindowBounds();
    clearTimeout(moveDebounce);
    moveDebounce = setTimeout(function () {
      var pos = mainWindow.getPosition();
      store.set('window.x', pos[0]);
      store.set('window.y', pos[1]);
    }, 300);
  });

  mainWindow.on('resize', function () {
    sendMainWindowBounds();
  });

  // 原生缩放结束后持久化最终尺寸(原生缩放不经过 window:set-bounds / resize:end)
  mainWindow.on('resized', function () {
    persistMainWindowBounds();
  });

  nativeTheme.on('updated', () => {
    if (store.get('window.followSystemTheme')) {
      mainWindow.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    }
  });
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 400,
    height: 340,
    frame: false,
    transparent: false,
    backgroundColor: '#00000000',
    roundedCorners: true,
    backgroundMaterial: 'acrylic',
    resizable: false,
    alwaysOnTop: true,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loginWindow.loadFile(path.join(__dirname, '..', 'renderer', 'login.html'));
  loginWindow.on('closed', () => {
    loginWindow = null;
  });
}

// 复用 DeepSeek 平台会话窗口:嗅探 /api/v0/usage/ 的非 sk- Bearer token。
function createSessionWindow() {
  console.log('[session] createSessionWindow called, sessionToken:', runtime.sessionToken ? 'present' : 'none');
  if (sessionWindow) {
    try { sessionWindow.close(); } catch (e) {}
    sessionWindow = null;
  }

  captureSession({
    logger: console,
    createSessionWindow: () => {
      sessionWindow = new BrowserWindow({
        width: 800,
        height: 600,
        show: true,
        center: true,
        title: '登录 DeepSeek 平台',
        webPreferences: {
          partition: 'persist:deepseek-platform',
          contextIsolation: true,
          nodeIntegration: false
        }
      });
      sessionWindow.on('closed', () => {
        sessionWindow = null;
        if (!runtime.sessionToken) {
          runtime.proxyStatus = { running: false, port: 0, error: '未登录 DeepSeek 平台' };
        }
        broadcastSessionState();
      });
      return sessionWindow;
    }
  })
    .then((token) => {
      runtime.sessionToken = token;
      store.set('providers.deepseek.sessionToken', token);
      runtime.proxyStatus = { running: true, port: 0, activeSince: Date.now() };
      broadcastSessionState();
      updateTrayMenu();
      if (scheduler) scheduler.poll('deepseek', 'usage');
    })
    .catch((err) => {
      runtime.proxyStatus = { running: false, port: 0, error: err.message || '未登录 DeepSeek 平台' };
      broadcastSessionState();
    });
}

function createTray() {
  const trayIconPath = path.join(__dirname, '..', 'renderer', 'assets', 'tray-icon.png');
  try {
    tray = new Tray(trayIconPath);
    tray.setToolTip('DeepSeek Monitor');
  } catch (e) {
    console.error('Failed to create tray:', e.message);
    return;
  }

  updateTrayMenu();

  tray.on('double-click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const loggedIn = !!runtime.sessionToken;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏悬浮窗',
      click: () => {
        if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
        else if (mainWindow) mainWindow.show();
      }
    },
    {
      label: loggedIn ? '重新登录平台' : '登录平台获取用量',
      click: () => createSessionWindow()
    },
    { type: 'separator' },
    {
      label: '设置',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.webContents.send('open:settings');
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
}

/* ======== 曲线点构建(旧逻辑原样保留) ======== */

function buildCurvePoints(stats) {
  const { localTodayStr } = require('./providers/deepseek/usage');
  var tokenPoints = [];
  var costPoints = [];
  var todayStr = localTodayStr();

  if (stats && stats.tokenDaily) {
    var cumToken = 0;
    stats.tokenDaily.forEach(function (d) {
      if (d.date > todayStr) return;
      cumToken += d.total;
      tokenPoints.push({ time: new Date(d.date).getTime(), totalTokens: cumToken, cumTokens: cumToken, deltaTokens: d.total, totalCost: 0, deltaCost: 0 });
    });
  }

  if (stats && stats.costDaily) {
    var cumCost = 0;
    stats.costDaily.forEach(function (d) {
      if (d.date > todayStr) return;
      cumCost += d.total;
      costPoints.push({ time: new Date(d.date).getTime(), totalCost: cumCost, cumCost: cumCost, deltaCost: d.total, totalTokens: 0, deltaTokens: 0 });
    });
  }

  return { token: tokenPoints, cost: costPoints };
}

/* ======== 窗口几何辅助 ======== */

function persistMainWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  var bounds = mainWindow.getBounds();

  store.set('window.width', bounds.width);
  store.set('window.height', bounds.height);
  store.set('window.x', bounds.x);
  store.set('window.y', bounds.y);

  return bounds;
}

function normalizeMainBounds(bounds) {
  var current = mainWindow.getBounds();

  function finite(value, fallback) {
    var num = Number(value);
    return Number.isFinite(num) ? Math.round(num) : fallback;
  }

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  var width = clamp(finite(bounds && bounds.width, current.width), 380, 2400);
  var height = clamp(finite(bounds && bounds.height, current.height), 200, 1600);
  var edge = bounds && typeof bounds.edge === 'string' ? bounds.edge : '';
  var x = current.x;
  var y = current.y;

  if (edge.indexOf('w') !== -1) {
    x = current.x + current.width - width;
  } else if (!edge) {
    x = finite(bounds && bounds.x, current.x);
  }

  if (edge.indexOf('n') !== -1) {
    y = current.y + current.height - height;
  } else if (!edge) {
    y = finite(bounds && bounds.y, current.y);
  }

  return {
    x: x,
    y: y,
    width: width,
    height: height
  };
}

/* ======== 设置窗口 ======== */

function createSettingsWindow() {
  // 开关语义:设置已打开时再次点击齿轮 = 关闭(避免 focus 重合成造成的闪烁)
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 370,
    height: 520,
    minWidth: 340,
    minHeight: 440,
    parent: mainWindow,
    modal: false,
    frame: false,
    transparent: false,
    backgroundColor: '#00000000',
    roundedCorners: true,
    backgroundMaterial: 'acrylic',
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings-window.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

/* ======== 设置应用 ======== */

function applySetting(key, value) {
  if (!mainWindow) return;
  switch (key) {
    // window.opacity 不再应用:setOpacity 的分层窗口机制会导致缩放露黑边,
    // 透视感已由 DWM acrylic 磨砂提供(key 保留在可写白名单,避免旧配置报错)
    case 'window.alwaysOnTop':
      mainWindow.setAlwaysOnTop(value);
      break;
    case 'window.autoLaunch':
      app.setLoginItemSettings({ openAtLogin: value });
      break;
    case 'window.followSystemTheme':
    case 'window.darkMode':
      applyTheme();
      break;
  }
}

function resolveDarkMode() {
  var mode = store.get('window.darkMode') || 'system';
  if (mode === 'dark') return true;
  if (mode === 'light') return false;
  return nativeTheme.shouldUseDarkColors;
}

function applyTheme() {
  var isDark = resolveDarkMode();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('theme:changed', isDark ? 'dark' : 'light');
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('theme:changed', isDark ? 'dark' : 'light');
  }
}

/* ======== 调度器 ======== */

function startSchedulerRuntime() {
  scheduler = startScheduler({
    registry,
    store,
    broadcast: (channel, payload) => broadcastToWindows(channel, payload),
    onStateChange: (providerId, state) => {
      if (providerId !== 'deepseek' || !state) return;
      if (state.authStatus === 'expired' && state.lastError) {
        runtime.proxyStatus = { running: false, port: 0, error: '会话已过期，请重新登录' };
        updateTrayMenu();
        broadcastSessionState();
      }
    }
  });
}

/* ======== App 生命周期 ======== */

app.whenReady().then(() => {
  migrateLegacyKeys(store);
  registry.register(deepseekProvider);
  registry.register(codexProvider);
  registry.register(kimiProvider);
  startSchedulerRuntime();

  setupIPC({
    store,
    registry,
    scheduler,
    runtime,
    resizeState,
    getMainWindow: () => mainWindow,
    getSettingsWindow: () => settingsWindow,
    getLoginWindow: () => loginWindow,
    createMainWindow,
    createLoginWindow,
    createSessionWindow,
    createSettingsWindow,
    broadcastSettings,
    broadcastSessionState,
    applySetting,
    persistMainWindowBounds,
    normalizeMainBounds,
    sendMainWindowBounds,
    buildCurvePoints
  });

  createTray();
  app.setLoginItemSettings({ openAtLogin: store.get('window.autoLaunch') });

  const apiKey = store.get('providers.deepseek.apiKey');
  if (apiKey) {
    createMainWindow();
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('settings:loaded', store.sanitizeSettings(store.store));
      scheduler.poll('deepseek', 'balance');

      runtime.sessionToken = store.get('providers.deepseek.sessionToken') || null;
      if (runtime.sessionToken) {
        console.log('[session] startup with stored token, starting usage timer');
        scheduler.poll('deepseek', 'usage');
        runtime.proxyStatus = { running: true, port: 0, activeSince: Date.now() };
      } else {
        console.log('[session] startup without token, opening platform login window');
        runtime.proxyStatus = { running: false, port: 0, error: '请登录平台获取用量' };
        createSessionWindow();
      }
    });
  } else {
    createLoginWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (scheduler) scheduler.stop();
  if (tray) { tray.destroy(); tray = null; }
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
