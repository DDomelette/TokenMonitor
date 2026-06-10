const { app, BrowserWindow, Tray, Menu, nativeTheme, ipcMain } = require('electron');
const path = require('path');
const store = require('./store');
const { fetchBalance } = require('./balance');
const { fetchUsageCost, fetchUsageAmount } = require('./fetcher');

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
let lastUsageStats = null;
let lastBalance = null;
let proxyStatus = { running: false, port: 0, error: '未获取数据' };

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

function createMainWindow() {
  const bounds = getWinBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: store.get('window.alwaysOnTop'),
    resizable: true,
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

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      mainWindow.hide();
      e.preventDefault();
    }
  });

  mainWindow.on('resize', () => {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      const [w, h] = mainWindow.getSize();
      store.set('window.width', w);
      store.set('window.height', h);
    }, 300);
  });

  mainWindow.on('move', () => {
    clearTimeout(moveDebounce);
    moveDebounce = setTimeout(() => {
      const [x, y] = mainWindow.getPosition();
      store.set('window.x', x);
      store.set('window.y', y);
    }, 300);
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
        store.set('sessionToken', sessionToken);
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

function startUsageTimer() {
  if (usageTimer) clearInterval(usageTimer);
  fetchAndStoreUsage();
  usageTimer = setInterval(fetchAndStoreUsage, 60 * 1000);
}

async function fetchAndStoreUsage() {
  if (!sessionToken) return;

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  try {
    var costData = await fetchUsageCost(sessionToken, month, year);
    var amountData = await fetchUsageAmount(sessionToken, month, year);
    lastUsageStats = {
      cost: costData.aggregate,
      token: amountData.aggregate,
      costDaily: costData.dailyData,
      tokenDaily: amountData.dailyData
    };
  } catch (e) {
    if (e.message && e.message.includes('Authorization')) {
      sessionToken = null;
      store.delete('sessionToken');
      lastUsageStats = null;
      proxyStatus = { running: false, port: 0, error: '会话已过期，请重新登录' };
      updateTrayMenu();
    }
  }
}

function buildCurvePoints(stats) {
  var tokenPoints = [];
  var costPoints = [];
  var todayStr = new Date().toISOString().slice(0, 10);

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
  });

  ipcMain.handle('get:settings', () => {
    return store.store;
  });

  ipcMain.on('settings:reset', () => {
    store.clear();
    if (mainWindow) {
      mainWindow.setOpacity(0.92);
      mainWindow.setAlwaysOnTop(true);
      mainWindow.webContents.send('settings:loaded', store.store);
    }
  });

  ipcMain.on('window:minimize', () => {
    if (mainWindow) mainWindow.hide();
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
      resizable: true,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      transparent: true,
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
        startUsageTimer();
        proxyStatus = { running: true, port: 0, activeSince: Date.now() };
      } else {
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
