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
const { wakeMostRelevantWindow } = require('./core/startup-windows');
const setupIPC = require('./ipc');
const { captureSession } = require('./providers/deepseek/session');
const {
  isAcrylicTheme,
  tintForTheme,
  isAccentSupported,
  applyAccent,
  clearAccent
} = require('./windows-backdrop');
const {
  clearSession,
  expireSession,
  getSessionSnapshot,
  getTraySessionLabel,
  restoreSession
} = require('./core/session-state');

let mainWindow = null;
let loginWindow = null;
let sessionWindow = null;
let settingsWindow = null;
let tray = null;
let scheduler = null;
let moveDebounce = null;

const runtime = {
  sessionToken: null,
  sessionStatus: 'missing',
  sessionError: null,
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
  wakeMostRelevantWindow({
    getMainWindow: () => mainWindow,
    getLoginWindow: () => loginWindow,
    getSettingsWindow: () => settingsWindow
  });
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
  var payload = getSessionSnapshot(runtime);
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
    // 先隐后显:Accent/DWM 磨砂要在窗口首次合成前就位;对已可见窗口
    // 应用 SWCA,DWM 不重算模糊区,表现是纯色,要等 resize 才突变透明
    show: false,
    // DWM 磨砂透明:替代整窗 setOpacity(分层窗口缩放会露黑边)
    ...windowMaterialOptions(),
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

  applyBackdropTo(mainWindow);
  revealWhenReady(mainWindow);
  mainWindow.on('blur', function () { notifyFocusState(mainWindow, false); });
  mainWindow.on('focus', function () { notifyFocusState(mainWindow, true); });

  nativeTheme.on('updated', () => {
    if (store.get('window.followSystemTheme')) {
      const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      mainWindow.webContents.send('theme:changed', theme);
      if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.webContents.send('theme:changed', theme);
      }
    }
    applyBackdropToAll();
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
    ...windowMaterialOptions(),
    resizable: false,
    alwaysOnTop: true,
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loginWindow.loadFile(path.join(__dirname, '..', 'renderer', 'login.html'));
  applyBackdropTo(loginWindow);
  revealWhenReady(loginWindow);
  loginWindow.on('blur', function () { notifyFocusState(loginWindow, false); });
  loginWindow.on('focus', function () { notifyFocusState(loginWindow, true); });
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
        const snapshot = getSessionSnapshot(runtime);
        if (!snapshot.loggedIn && snapshot.status !== 'expired') {
          clearSession(runtime, '未登录 DeepSeek 平台');
          runtime.proxyStatus = { running: false, port: 0, error: '未登录 DeepSeek 平台' };
        }
        broadcastSessionState();
        updateTrayMenu();
      });
      return sessionWindow;
    }
  })
    .then((token) => {
      restoreSession(runtime, token);
      store.set('providers.deepseek.sessionToken', token);
      runtime.proxyStatus = { running: true, port: 0, activeSince: Date.now() };
      broadcastSessionState();
      updateTrayMenu();
      if (scheduler) scheduler.poll('deepseek', 'usage');
    })
    .catch((err) => {
      const snapshot = getSessionSnapshot(runtime);
      const message = err.message || '未登录 DeepSeek 平台';
      if (!snapshot.loggedIn && snapshot.status !== 'expired') {
        clearSession(runtime, message);
      }
      runtime.proxyStatus = { running: false, port: 0, error: message };
      broadcastSessionState();
      updateTrayMenu();
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
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏悬浮窗',
      click: () => {
        if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
        else if (mainWindow) mainWindow.show();
      }
    },
    {
      label: getTraySessionLabel(getSessionSnapshot(runtime)),
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
    ...windowMaterialOptions(),
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    useContentSize: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings-window.html'));
  applyBackdropTo(settingsWindow);
  revealWhenReady(settingsWindow);
  settingsWindow.on('blur', function () { notifyFocusState(settingsWindow, false); });
  settingsWindow.on('focus', function () { notifyFocusState(settingsWindow, true); });
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
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.webContents.send('theme:changed', isDark ? 'dark' : 'light');
  }
  applyBackdropToAll();
}

/* ======== Accent 亚克力背景(失焦不褪色) ======== */

// 先隐后显的配套:窗口创建时 show:false,Accent/DWM 磨砂在隐藏态就位,
// 首帧合成即带磨砂。渲染就绪后 reveal;ready-to-show 不触发时 5s 兜底,
// 避免加载异常导致窗口永远不出现
function revealWhenReady(win) {
  if (!win || win.isDestroyed()) return;
  var revealed = false;
  function reveal() {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    win.show();
  }
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 5000);
}

// 记录 Accent 已在哪些窗口生效:主题切换时决定 enable/clear,
// 也用于失焦实心化(路线 B)与 Accent 持久透明的互斥
const accentAppliedWindows = new WeakSet();

// 与渲染端 resolveTheme 同语义:跟随系统主开关优先,亚克力为显式手动模式
function resolveEffectiveTheme() {
  var follow = store.get('window.followSystemTheme');
  if (follow === undefined) follow = true;
  var mode = store.get('window.darkMode') || 'system';
  if (follow || mode === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return mode;
}

// Accent 可用时不再使用 backgroundMaterial(DWMWA_SYSTEMBACKDROP_TYPE):
// 后者失焦必退化为纯色,且两套背景机制不应叠加在同一窗口上
function useAccentBackdrop() {
  // 应急/诊断开关:DSM_DISABLE_ACCENT=1 时退回官方 backgroundMaterial 路径
  if (process.env.DSM_DISABLE_ACCENT) return false;
  return isAccentSupported();
}

function windowMaterialOptions() {
  return useAccentBackdrop() ? {} : { backgroundMaterial: 'acrylic' };
}

function applyBackdropTo(win) {
  if (!win || win.isDestroyed() || !useAccentBackdrop()) return;
  var theme = resolveEffectiveTheme();
  if (isAcrylicTheme(theme)) {
    if (applyAccent(win, { argb: tintForTheme(theme) })) {
      accentAppliedWindows.add(win);
    } else {
      // Accent 失败回退官方材质;失焦退化由渲染端失焦实心化兜底
      try { win.setBackgroundMaterial('acrylic'); } catch (_) {}
    }
  } else if (accentAppliedWindows.has(win)) {
    if (clearAccent(win)) accentAppliedWindows.delete(win);
  }
}

function applyBackdropToAll() {
  applyBackdropTo(mainWindow);
  applyBackdropTo(settingsWindow);
  applyBackdropTo(loginWindow);
}

// 路线 B:失焦实心化只在 Accent 未生效时下发,避免盖住 Accent 的持久透明
function notifyFocusState(win, focused) {
  if (!win || win.isDestroyed() || accentAppliedWindows.has(win)) return;
  win.webContents.send('window:focus-state', focused);
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
        expireSession(runtime, '会话已过期，请重新登录');
        store.delete('providers.deepseek.sessionToken');
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

      const storedSessionToken = store.get('providers.deepseek.sessionToken') || null;
      restoreSession(runtime, storedSessionToken);
      if (getSessionSnapshot(runtime).loggedIn) {
        console.log('[session] startup with stored token, starting usage timer');
        scheduler.poll('deepseek', 'usage');
        runtime.proxyStatus = { running: true, port: 0, activeSince: Date.now() };
      } else {
        console.log('[session] startup without token, opening platform login window');
        clearSession(runtime, '请登录平台获取用量');
        runtime.proxyStatus = { running: false, port: 0, error: '请登录平台获取用量' };
        createSessionWindow();
      }
      broadcastSessionState();
      updateTrayMenu();
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
