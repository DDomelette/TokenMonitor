const { app, BrowserWindow, Tray, Menu, nativeTheme, ipcMain } = require('electron');
const path = require('path');
const store = require('./store');
const { fetchBalance } = require('./balance');
const { fetchUsageWithFallback, localTodayStr } = require('./fetcher');

let mainWindow = null;
let loginWindow = null;
let sessionWindow = null;
let settingsWindow = null;
let tray = null;
let balanceTimer = null;
let usageTimer = null;
let resizeDebounce = null;
let moveDebounce = null;
let sessionToken = null;
let sessionReopenPending = false;
let lastUsageStats = null;
let lastBalance = null;
let proxyStatus = { running: false, port: 0, error: '未获取数据' };
let mainResizeState = null;
let settingsResizeState = null;

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
  if (mainResizeState) return;
  mainWindow.webContents.send('window:bounds-changed', mainWindow.getBounds());
}

function broadcastSettings() {
  [mainWindow, settingsWindow].forEach(function (win) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('settings:loaded', store.store);
  });
}

function broadcastSessionState() {
  var payload = { loggedIn: !!sessionToken, error: proxyStatus.error || null };
  [mainWindow, settingsWindow].forEach(function (win) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('session:changed', payload);
  });
}

function createMainWindow() {
  const bounds = getWinBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: store.get('window.alwaysOnTop'),
    resizable: false,
    minWidth: 380,
    minHeight: 200,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setOpacity(store.get('window.opacity') / 100);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

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
    if (mainResizeState) return;
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
    transparent: true,
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

function createSessionWindow() {
  console.log('[session] createSessionWindow called, sessionToken:', sessionToken ? 'present' : 'none');
  if (sessionWindow) {
    try { sessionWindow.close(); } catch (e) {}
    sessionWindow = null;
  }

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

  const ses = sessionWindow.webContents.session;

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.url.includes('/api/v0/usage/') && details.requestHeaders['authorization']) {
      const auth = details.requestHeaders['authorization'];
      if (auth.startsWith('Bearer ') && !auth.includes('sk-')) {
        sessionToken = auth.replace('Bearer ', '');
        sessionReopenPending = false;
        store.set('sessionToken', sessionToken);
        broadcastSessionState();
        proxyStatus = { running: true, port: 0, activeSince: Date.now() };

        if (sessionWindow) {
          try { sessionWindow.close(); } catch (e) {}
          sessionWindow = null;
        }

        startUsageTimer();
      }
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  sessionWindow.loadURL('https://platform.deepseek.com/usage');

  sessionWindow.on('closed', () => {
    sessionWindow = null;
    if (!sessionToken) {
      proxyStatus = { running: false, port: 0, error: '未登录 DeepSeek 平台' };
    }
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
  const loggedIn = !!sessionToken;
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

function startBalanceTimer() {
  if (balanceTimer) clearInterval(balanceTimer);
  const apiKey = store.get('apiKey');
  if (!apiKey) return;

  fetchAndStoreBalance();
  balanceTimer = setInterval(fetchAndStoreBalance, 60 * 1000);
}

async function fetchAndStoreBalance() {
  const apiKey = store.get('apiKey');
  if (!apiKey) return;
  try {
    const info = await fetchBalance(apiKey);
    if (info) lastBalance = info;
  } catch (e) {}
}

function debugDumpUsageRaw() {
  if (!sessionToken) return;
  const https = require('https');
  [7, 8].forEach(function (month) {
    var req = https.request({
      hostname: 'platform.deepseek.com',
      path: '/api/v0/usage/cost?month=' + month + '&year=2026',
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + sessionToken,
        'Accept': 'application/json',
        'x-app-version': '1.0.0'
      }
    }, function (res) {
      var body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        console.log('[raw] month=' + month + ' status=' + res.statusCode + ' body[:600]=' + body.slice(0, 600));
      });
    });
    req.on('error', function (e) { console.error('[raw] month=' + month + ' error: ' + e.message); });
    req.setTimeout(15000, function () { req.destroy(); });
    req.end();
  });
}

function startUsageTimer() {
  if (usageTimer) clearInterval(usageTimer);
  fetchAndStoreUsage();
  debugDumpUsageRaw();
  usageTimer = setInterval(fetchAndStoreUsage, 60 * 1000);
}

async function fetchAndStoreUsage() {
  if (!sessionToken) return;

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  try {
    var usageResult = await fetchUsageWithFallback(sessionToken, month, year);
    var costData = usageResult.cost;
    var amountData = usageResult.amount;
    if (usageResult.fellBack) {
      console.log('[usage] current month (' + month + '/' + year + ') empty, showing ' + usageResult.month + '/' + usageResult.year);
    }
    console.log('[usage] cost total=' + costData.aggregate.totalCost +
      ' token total=' + amountData.aggregate.totalTokens +
      ' today=' + localTodayStr());
    console.log('[usage] last cost days: ' + JSON.stringify(costData.dailyData.slice(-3).map(function (d) { return { date: d.date, total: d.total }; })));
    console.log('[usage] last token days: ' + JSON.stringify(amountData.dailyData.slice(-3).map(function (d) { return { date: d.date, total: d.total }; })));
    lastUsageStats = {
      cost: costData.aggregate,
      token: amountData.aggregate,
      costDaily: costData.dailyData,
      tokenDaily: amountData.dailyData
    };
  } catch (e) {
    console.error('[usage] fetch failed:', e && e.message);
    if (e.message && /unauthoriz|authorization|401|403|登录|expired|invalid token/i.test(e.message)) {
      sessionToken = null;
      store.delete('sessionToken');
      lastUsageStats = null;
      proxyStatus = { running: false, port: 0, error: '会话已过期，请重新登录' };
      updateTrayMenu();
      broadcastSessionState();
      if (!sessionReopenPending) {
        sessionReopenPending = true;
        console.log('[session] expired, reopening platform login window');
        createSessionWindow();
      }
    }
  }
}

function buildCurvePoints(stats) {
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

function setupIPC() {
  ipcMain.on('login:submit', async (event, { apiKey }) => {
    try {
      await fetchBalance(apiKey);
      store.set('apiKey', apiKey);
      if (loginWindow) loginWindow.close();
      if (!mainWindow) createMainWindow();
      else mainWindow.show();
      mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('settings:loaded', store.store);
        startBalanceTimer();
        createSessionWindow();
      });
    } catch (e) {
      if (loginWindow && !loginWindow.isDestroyed()) {
        event.sender.send('login:error', 'API Key 验证失败: ' + e.message);
      }
    }
  });

  ipcMain.handle('get:dashboard', () => {
    const curves = buildCurvePoints(lastUsageStats);
    return {
      balance: lastBalance,
      stats: lastUsageStats,
      proxyStatus: proxyStatus,
      curveToken: curves.token,
      curveCost: curves.cost
    };
  });

  ipcMain.on('settings:update', (event, { key, value }) => {
    store.set(key, value);
    applySetting(key, value);
    broadcastSettings();
  });

  ipcMain.handle('get:settings', () => {
    return store.store;
  });

  ipcMain.on('settings:reset', () => {
    store.clear();
    if (mainWindow) {
      mainWindow.setOpacity(0.92);
      mainWindow.setAlwaysOnTop(true);
    }
    broadcastSettings();
  });

  ipcMain.handle('get:bounds', () => {
    if (!mainWindow) return null;
    return mainWindow.getBounds();
  });

  ipcMain.handle('window:commit', (event, bounds) => {
    if (!mainWindow) return null;
    var next = normalizeMainBounds(bounds);
    var current = mainWindow.getBounds();
    var sameSize = current.width === next.width && current.height === next.height;

    if (sameSize) {
      return persistMainWindowBounds();
    }

    mainWindow.setBounds(next);
    return persistMainWindowBounds();
  });

  ipcMain.on('window:set-bounds', (event, bounds) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== mainWindow || win.isDestroyed()) return;
    var next = normalizeMainBounds(bounds);
    var current = win.getBounds();
    if (current.x === next.x && current.y === next.y
        && current.width === next.width && current.height === next.height) {
      return;
    }
    win.setBounds(next, false);
  });

  ipcMain.on('window:minimize', () => {
    if (mainWindow) mainWindow.hide();
  });

  ipcMain.on('zoom:change', (event, { delta }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    var current = mainWindow.webContents.getZoomFactor();
    var next = Math.min(1.6, Math.max(0.7, Math.round((current + delta) * 100) / 100));
    mainWindow.webContents.setZoomFactor(next);
    store.set('window.zoomFactor', next);
  });

  ipcMain.on('session:relogin', () => {
    createSessionWindow();
  });

  ipcMain.handle('get:session-state', () => {
    return { loggedIn: !!sessionToken, error: proxyStatus.error || null };
  });

  ipcMain.on('window:close', () => {
    if (loginWindow) loginWindow.close();
  });

  ipcMain.on('window:close-settings', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.close();
    }
  });

  ipcMain.on('refresh:dashboard', async () => {
    fetchAndStoreBalance();
    if (sessionToken) {
      fetchAndStoreUsage();
    }
  });

  var originalSettingsBtn = true;
  ipcMain.on('open:settings', (event) => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.focus();
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
      transparent: true,
      backgroundColor: '#00000000',
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
  });

  function getResizeState(win) {
    if (win === mainWindow) return mainResizeState;
    if (win === settingsWindow) return settingsResizeState;
    return null;
  }

  function setResizeState(win, state) {
    if (win === mainWindow) mainResizeState = state;
    else if (win === settingsWindow) settingsResizeState = state;
  }

  function applyResizeBounds(win, state) {
    if (!state || !state.pendingBounds || !win || win.isDestroyed()) return;
    var next = state.pendingBounds;
    state.pendingBounds = null;
    var current = win.getBounds();
    if (current.x !== next.x || current.y !== next.y
        || current.width !== next.width || current.height !== next.height) {
      win.setBounds(next, false);
    }
  }

  function scheduleResizeFrame(win, state) {
    if (state.timer) return;
    state.timer = setTimeout(function () {
      state.timer = null;
      if (getResizeState(win) !== state) return;
      applyResizeBounds(win, state);
    }, 16);
  }

  function flushResizeFrame(win, state) {
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    applyResizeBounds(win, state);
  }

  ipcMain.on('resize:start', (event, { edge, screenX, screenY }) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    var bounds = win.getBounds();
    setResizeState(win, {
      edge: edge,
      startBounds: bounds,
      startScreenX: screenX,
      startScreenY: screenY,
      pendingBounds: null,
      timer: null
    });
  });

  ipcMain.on('resize:move', (event, { screenX, screenY }) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    var state = getResizeState(win);
    if (!state) return;

    var dx = screenX - state.startScreenX;
    var dy = screenY - state.startScreenY;
    var newBounds = { x: state.startBounds.x, y: state.startBounds.y, width: state.startBounds.width, height: state.startBounds.height };
    var edge = state.edge;
    var isSettings = win === settingsWindow;
    var minW = isSettings ? 340 : 380;
    var minH = isSettings ? 440 : 200;
    var maxW = isSettings ? 1600 : 2400;
    var maxH = isSettings ? 1200 : 1600;

    if (edge.indexOf('e') !== -1) {
      newBounds.width = Math.min(maxW, Math.max(minW, state.startBounds.width + dx));
    }
    if (edge.indexOf('w') !== -1) {
      var proposedW = Math.min(maxW, Math.max(minW, state.startBounds.width - dx));
      newBounds.x = state.startBounds.x + state.startBounds.width - proposedW;
      newBounds.width = proposedW;
    }
    if (edge.indexOf('s') !== -1) {
      newBounds.height = Math.min(maxH, Math.max(minH, state.startBounds.height + dy));
    }
    if (edge.indexOf('n') !== -1) {
      var proposedH = Math.min(maxH, Math.max(minH, state.startBounds.height - dy));
      newBounds.y = state.startBounds.y + state.startBounds.height - proposedH;
      newBounds.height = proposedH;
    }

    state.pendingBounds = newBounds;
    scheduleResizeFrame(win, state);
  });

  ipcMain.on('resize:end', (event) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    var state = getResizeState(win);
    flushResizeFrame(win, state);
    setResizeState(win, null);

    if (win === mainWindow) {
      persistMainWindowBounds();
      sendMainWindowBounds();
    }
  });
}

function applySetting(key, value) {
  if (!mainWindow) return;
  switch (key) {
    case 'window.opacity':
      mainWindow.setOpacity(value / 100);
      break;
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

app.whenReady().then(() => {
  setupIPC();
  createTray();
  app.setLoginItemSettings({ openAtLogin: store.get('window.autoLaunch') });

  const apiKey = store.get('apiKey');
  if (apiKey) {
    createMainWindow();
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('settings:loaded', store.store);
      startBalanceTimer();

      sessionToken = store.get('sessionToken');
      if (sessionToken) {
        console.log('[session] startup with stored token, starting usage timer');
        startUsageTimer();
        proxyStatus = { running: true, port: 0, activeSince: Date.now() };
      } else {
        console.log('[session] startup without token, opening platform login window');
        proxyStatus = { running: false, port: 0, error: '请登录平台获取用量' };
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
  if (balanceTimer) clearInterval(balanceTimer);
  if (usageTimer) clearInterval(usageTimer);
  if (tray) { tray.destroy(); tray = null; }
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
