const { app, BrowserWindow, Tray, Menu, nativeTheme, ipcMain } = require('electron');
const path = require('path');
const store = require('./store');
const ProxyServer = require('./proxy');
const Aggregator = require('./aggregator');
const { fetchBalance } = require('./balance');

let mainWindow = null;
let loginWindow = null;
let tray = null;
let proxyServer = null;
let aggregator = null;
let balanceTimer = null;
let ringBufferTimer = null;
let persistTimer = null;
const dataDir = app.getPath('userData');

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
    minWidth: 320,
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
    mainWindow.hide();
    e.preventDefault();
  });

  mainWindow.on('resize', () => {
    const [w, h] = mainWindow.getSize();
    store.set('window.width', w);
    store.set('window.height', h);
  });

  mainWindow.on('move', () => {
    const [x, y] = mainWindow.getPosition();
    store.set('window.x', x);
    store.set('window.y', y);
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
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loginWindow.loadFile(path.join(__dirname, '..', 'renderer', 'login.html'));
}

function createTray() {
  const trayIconPath = path.join(__dirname, '..', 'renderer', 'assets', 'tray-icon.png');
  tray = new Tray(trayIconPath);
  tray.setToolTip('DeepSeek Monitor');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏悬浮窗',
      click: () => {
        if (mainWindow && mainWindow.isVisible()) {
          mainWindow.hide();
        } else if (mainWindow) {
          mainWindow.show();
        }
      }
    },
    {
      label: proxyServer && proxyServer.running ? '暂停代理' : '启用代理',
      click: () => toggleProxy()
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

  tray.on('double-click', () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
}

async function toggleProxy() {
  if (proxyServer && proxyServer.running) {
    await proxyServer.stop();
  } else if (proxyServer) {
    await proxyServer.start();
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const label = proxyServer && proxyServer.running ? '暂停代理' : '启用代理';
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏悬浮窗',
      click: () => {
        if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
        else if (mainWindow) mainWindow.show();
      }
    },
    { label, click: () => toggleProxy() },
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

  fetchAndSendBalance();
  balanceTimer = setInterval(fetchAndSendBalance, 5 * 60 * 1000);
}

async function fetchAndSendBalance() {
  const apiKey = store.get('apiKey');
  if (!apiKey || !mainWindow) return;
  try {
    const info = await fetchBalance(apiKey);
    if (mainWindow && info) {
      mainWindow.webContents.send('balance:update', info);
    }
  } catch (e) {}
}

function startRingBufferTimer() {
  if (ringBufferTimer) clearInterval(ringBufferTimer);
  const interval = (store.get('data.sampleInterval') || 30) * 1000;
  ringBufferTimer = setInterval(() => {
    if (!aggregator || !mainWindow) return;
    aggregator.sampleRingBuffer();
    const defaultRange = store.get('data.defaultTimeRange') || '1m';
    const tokenPoints = aggregator.getPointsForRange(defaultRange);
    const costPoints = aggregator.getPointsForRange(defaultRange);
    mainWindow.webContents.send('curve:token', { points: tokenPoints });
    mainWindow.webContents.send('curve:cost', { points: costPoints });
  }, interval);
}

function startPersistTimer() {
  if (persistTimer) clearInterval(persistTimer);
  persistTimer = setInterval(() => {
    if (aggregator) aggregator.saveHistory();
  }, 5 * 60 * 1000);
}

function setupIPC() {
  ipcMain.on('login:submit', async (event, { apiKey }) => {
    try {
      await fetchBalance(apiKey);
      store.set('apiKey', apiKey);
      startServices();
      if (loginWindow) loginWindow.close();
      if (!mainWindow) createMainWindow();
      else mainWindow.show();
    } catch (e) {
      event.sender.send('login:error', 'API Key 验证失败: ' + e.message);
    }
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
    applyAllSettings();
    if (mainWindow) {
      mainWindow.webContents.send('settings:loaded', store.store);
    }
  });

  ipcMain.on('proxy:restart', async () => {
    await restartProxy();
  });

  ipcMain.on('proxy:toggle', async () => {
    await toggleProxy();
  });

  ipcMain.on('window:minimize', () => {
    if (mainWindow) mainWindow.hide();
  });

  ipcMain.on('window:close', () => {
    if (loginWindow) loginWindow.close();
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
    case 'data.proxyPort':
      restartProxy();
      break;
    case 'data.sampleInterval':
      startRingBufferTimer();
      break;
    case 'data.defaultTimeRange':
      if (aggregator && mainWindow) {
        const points = aggregator.getPointsForRange(value);
        mainWindow.webContents.send('curve:token', { points });
        mainWindow.webContents.send('curve:cost', { points });
      }
      break;
  }
}

function applyAllSettings() {
  if (!mainWindow) return;
  mainWindow.setOpacity(store.get('window.opacity') / 100);
  mainWindow.setAlwaysOnTop(store.get('window.alwaysOnTop'));
  app.setLoginItemSettings({ openAtLogin: store.get('window.autoLaunch') });
}

async function restartProxy() {
  if (proxyServer) await proxyServer.stop();
  const port = store.get('data.proxyPort') || 7890;
  const apiKey = store.get('apiKey');
  if (apiKey) {
    proxyServer.updateApiKey(apiKey);
    await proxyServer.start();
    updateTrayMenu();
    if (mainWindow) {
      mainWindow.webContents.send('proxy:status', {
        running: true,
        port: port,
        activeSince: proxyServer.activeSince
      });
    }
  }
}

function startServices() {
  const apiKey = store.get('apiKey');
  if (!apiKey) return;

  aggregator = new Aggregator(dataDir);

  proxyServer = new ProxyServer(
    store.get('data.proxyPort') || 7890,
    apiKey,
    aggregator,
    (status) => {
      if (mainWindow) mainWindow.webContents.send('proxy:status', status);
    }
  );

  proxyServer.start().then(() => {
    updateTrayMenu();
  }).catch((err) => {
    if (mainWindow) {
      mainWindow.webContents.send('proxy:status', {
        running: false,
        port: store.get('data.proxyPort') || 7890,
        error: err.message
      });
    }
  });

  const origHandle = proxyServer.handleRequest.bind(proxyServer);
  proxyServer.handleRequest = (clientReq, clientRes) => {
    origHandle(clientReq, clientRes);
    const origEnd = clientRes.end.bind(clientRes);
    clientRes.end = function (...args) {
      setTimeout(() => {
        if (mainWindow && aggregator) {
          const stats = aggregator.getTodayStats();
          mainWindow.webContents.send('data:update', stats);
        }
      }, 0);
      return origEnd(...args);
    };
  };

  startBalanceTimer();
  startRingBufferTimer();
  startPersistTimer();
}

app.on('ready', () => {
  setupIPC();
  createTray();
  app.setLoginItemSettings({ openAtLogin: store.get('window.autoLaunch') });

  const apiKey = store.get('apiKey');
  if (apiKey) {
    createMainWindow();
    startServices();
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('settings:loaded', store.store);
    });
  } else {
    createLoginWindow();
  }
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (balanceTimer) clearInterval(balanceTimer);
  if (ringBufferTimer) clearInterval(ringBufferTimer);
  if (persistTimer) clearInterval(persistTimer);
  if (proxyServer) proxyServer.stop();
  if (aggregator) aggregator.saveHistory();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});
