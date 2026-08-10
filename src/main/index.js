const { app, BrowserWindow, Tray, Menu, nativeTheme, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { migrateLegacyKeys } = store;
const registry = require('./providers/registry');
const deepseekProvider = require('./providers/deepseek');
const codexProvider = require('./providers/codex');
const kimiProvider = require('./providers/kimi');
const { startScheduler } = require('./core/scheduler');
const { createTokenSpeedRuntime } = require('./core/token-speed-runtime');
const { wakeMostRelevantWindow } = require('./core/startup-windows');
const { createEdgeDock } = require('./core/edge-dock');
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
let tokenSpeedRuntime = null;
let moveDebounce = null;
// 贴边自动隐藏状态机(issue #170),随主窗口创建
let edgeDock = null;

const runtime = {
  sessionToken: null,
  sessionStatus: 'missing',
  sessionError: null
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
  if (edgeDock) edgeDock.reveal();
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
  // 贴边动画每帧都在变,跳过广播避免高频 IPC;动画结束后的 move 事件会补发
  if (edgeDock && edgeDock.isProgrammatic()) return;
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

// 贴边自动隐藏(issue #170):几何/状态机在 core/edge-dock.js,这里只做接线。
// 隐藏坐标只存内存,持久化的永远是展开可见 bounds(window.edgeDock 元数据)。
//
// 程序性 setBounds 的静默期:Windows 的 setBounds 是异步的,move 事件可能严重
// 滞后到达(动画已结束,而 getBounds 返回 DWM 未播完的几帧前中间位置)——
// 靠坐标猜回声会误判成用户拖动 → 取消停靠 → debounce 在收起位置重新吸附
// (收起位置距边缘为负值,仍 ≤ 阈值)→ 窗口弹出 → 再收起,循环抖动。
// 所以动画进行中及最后一次程序性 setBounds 后 250ms 内的 move 事件一律忽略。
const EDGE_DOCK_MOVE_QUIET_MS = 250;
let lastEdgeDockApplyAt = 0;

function createEdgeDockRuntime() {
  edgeDock = createEdgeDock({
    onApplyBounds: function (b) {
      lastEdgeDockApplyAt = Date.now();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBounds(b);
    },
    onPersistDock: function (meta) {
      store.set('window.edgeDock', meta);
    },
    // 收起前的最终裁决依据:光标真实位置(enter/leave 事件在边界会丢失/乱序)
    getCursorPoint: function () {
      try { return screen.getCursorScreenPoint(); } catch (_) { return null; }
    }
  });
  // 重启恢复逻辑停靠:重新匹配当前显示器,落不进现存 workArea 的由状态机修正
  if (store.get('window.edgeAutoHide')) {
    var meta = store.get('window.edgeDock');
    if (meta) edgeDock.restoreDock(meta, screen.getAllDisplays());
  }
}

// 主动唤醒(托盘/第二实例/打开设置):已收起的窗口先完整展开
function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  if (edgeDock) edgeDock.reveal();
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
  createEdgeDockRuntime();

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
    // 静默期(动画中 + 末帧后 250ms)的 move 事件一律视为程序性回声,见上方注释。
    // 用户真实拖动不刷新 lastEdgeDockApplyAt,不受影响
    if (edgeDock && (edgeDock.isProgrammatic() || Date.now() - lastEdgeDockApplyAt < EDGE_DOCK_MOVE_QUIET_MS)) return;
    // 非动画的程序性 setBounds(吸附落定/恢复)的回声:不广播、不落盘、不重新评估停靠
    if (edgeDock && edgeDock.matchesCurrent(mainWindow.getBounds())) return;
    // 非回声 move = 用户在拖动:立即解除停靠,窗口才不会被吸附拽住
    if (edgeDock && store.get('window.edgeAutoHide')) edgeDock.userMoveStarted();
    sendMainWindowBounds();
    clearTimeout(moveDebounce);
    moveDebounce = setTimeout(function () {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (edgeDock && (edgeDock.isProgrammatic() || edgeDock.matchesCurrent(mainWindow.getBounds()))) return;
      if (edgeDock && store.get('window.edgeAutoHide')) {
        edgeDock.userMoveSettled(mainWindow.getBounds(), screen.getAllDisplays());
      }
      persistMainWindowBounds();
    }, 300);
  });

  mainWindow.on('resize', function () {
    sendMainWindowBounds();
  });

  // 原生缩放结束后持久化最终尺寸(原生缩放不经过 window:set-bounds / resize:end)
  mainWindow.on('resized', function () {
    if (edgeDock && edgeDock.getDockMeta()) {
      edgeDock.resizeSettled(mainWindow.getBounds(), screen.getAllDisplays());
    }
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
      revealMainWindow();
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
        else if (mainWindow) revealMainWindow();
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
          revealMainWindow();
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

  // 停靠中(含已收起)持久化展开可见 bounds,隐藏坐标永不落盘(issue #170)
  var meta = edgeDock && edgeDock.getDockMeta();
  var bounds = meta ? { x: meta.expandedBounds.x, y: meta.expandedBounds.y, width: meta.expandedBounds.width, height: meta.expandedBounds.height } : mainWindow.getBounds();

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
  // 打开设置时主窗口保持完整展开并暂停自动收起(issue #170)
  if (edgeDock) {
    edgeDock.setSuspended(true);
    edgeDock.reveal();
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
  settingsWindow.on('closed', () => {
    settingsWindow = null;
    if (edgeDock) edgeDock.setSuspended(false);
  });
}

/* ======== 设置应用 ======== */

function applySetting(key, value) {
  switch (key) {
    case 'components.tokenSpeed':
    case 'data.tokenSpeed.intervalSeconds':
    case 'data.tokenSpeed.providerFilter':
      if (tokenSpeedRuntime) tokenSpeedRuntime.applySettings();
      return;
    case 'data.historyDays':
      if (tokenSpeedRuntime) tokenSpeedRuntime.rebaselineAll();
      return;
  }
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
    case 'window.edgeAutoHide':
      // 关闭开关:即使已收起也先完整恢复,再清停靠状态(issue #170)
      if (!value && edgeDock) edgeDock.disable();
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
        updateTrayMenu();
        broadcastSessionState();
      }
    },
    onUsageObservation: (providerId, detail) => {
      if (tokenSpeedRuntime) tokenSpeedRuntime.observeProvider(providerId, detail.observedAt);
    },
    onUsageUnavailable: (providerId, detail) => {
      if (tokenSpeedRuntime) tokenSpeedRuntime.markProviderUnavailable(providerId, detail);
    }
  });
  tokenSpeedRuntime = createTokenSpeedRuntime({
    store,
    registry,
    scheduler,
    broadcast: (channel, payload) => broadcastToWindows(channel, payload)
  });
  tokenSpeedRuntime.start();
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
    tokenSpeedRuntime,
    runtime,
    resizeState,
    getMainWindow: () => mainWindow,
    getSettingsWindow: () => settingsWindow,
    getLoginWindow: () => loginWindow,
    getEdgeDock: () => edgeDock,
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
      } else {
        console.log('[session] startup without token, opening platform login window');
        clearSession(runtime, '请登录平台获取用量');
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
  if (tokenSpeedRuntime) tokenSpeedRuntime.stop();
  if (scheduler) scheduler.stop();
  if (tray) { tray.destroy(); tray = null; }
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
