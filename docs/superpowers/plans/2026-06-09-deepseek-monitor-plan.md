# DeepSeek Monitor 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Electron 桌面悬浮窗应用，通过本地 HTTP 代理实时监控 DeepSeek API 的 token 消耗、缓存命中率和费用增长。

**Architecture:** 单进程 Electron，Main Process 运行 HTTP 代理 + 数据聚合器 + 余额拉取，通过 IPC 推送数据到 Renderer Process 的悬浮窗 UI。UI 由 4 个可拖拽排序的 ECharts/HTML 组件构成。所有设置通过 electron-store 持久化。

**Tech Stack:** Electron 28+, ECharts 5, electron-store, electron-builder, 原生 HTML/CSS/JS (无框架)

---

### Task 1: 项目初始化

**Files:**
- Create: `d:\Deepseek_Monitor\package.json`
- Create: `d:\Deepseek_Monitor\electron-builder.yml`
- Create: `d:\Deepseek_Monitor\.gitignore`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "deepseek-monitor",
  "version": "1.0.0",
  "description": "DeepSeek API 用量监控悬浮窗",
  "main": "src/main/index.js",
  "scripts": {
    "start": "electron .",
    "build:win": "electron-builder --win",
    "build:mac": "electron-builder --mac"
  },
  "author": "",
  "license": "MIT",
  "dependencies": {
    "echarts": "^5.5.0",
    "electron-store": "^8.1.0"
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^24.9.0"
  }
}
```

- [ ] **Step 2: 创建 electron-builder.yml**

```yaml
appId: com.deepseek.monitor
productName: DeepSeek Monitor
directories:
  output: build
files:
  - src/**/*
  - node_modules/**/*
  - package.json
win:
  icon: assets/icon.ico
  target: nsis
mac:
  icon: assets/icon.icns
  target: dmg
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

- [ ] **Step 3: 创建 .gitignore**

```
node_modules/
build/
dist/
*.log
```

- [ ] **Step 4: 安装依赖**

```powershell
cd d:\Deepseek_Monitor; npm install
```

- [ ] **Step 5: Commit**

```bash
git add package.json electron-builder.yml .gitignore
git commit -m "chore: init Electron project with dependencies"
```

---

### Task 2: 预加载脚本 (IPC Bridge)

**Files:**
- Create: `d:\Deepseek_Monitor\src\preload\preload.js`

- [ ] **Step 1: 创建 preload.js**

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  on: (channel, callback) => {
    const validChannels = [
      'data:update',
      'balance:update',
      'curve:token',
      'curve:cost',
      'proxy:status',
      'settings:loaded'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },

  send: (channel, data) => {
    const validChannels = [
      'settings:update',
      'settings:reset',
      'proxy:restart',
      'proxy:toggle',
      'login:submit',
      'window:minimize',
      'window:close',
      'get:settings'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },

  invoke: (channel, ...args) => {
    const validChannels = ['get:settings'];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error(`Invalid channel: ${channel}`));
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add src/preload/preload.js
git commit -m "feat: add preload script with IPC bridge"
```

---

### Task 3: 配置存储

**Files:**
- Create: `d:\Deepseek_Monitor\src\main\store.js`

- [ ] **Step 1: 创建 store.js**

```js
const Store = require('electron-store');

const defaults = {
  apiKey: '',
  window: {
    x: undefined,
    y: undefined,
    width: 420,
    height: 680,
    opacity: 92,
    alwaysOnTop: true,
    autoLaunch: false,
    followSystemTheme: true,
    layoutLocked: true
  },
  components: {
    feeCards: true,
    modelBar: true,
    tokenLine: true,
    costLine: true
  },
  componentOrder: ['fee-cards', 'model-bar', 'token-line', 'cost-line'],
  data: {
    sampleInterval: 30,
    defaultTimeRange: '1h',
    proxyPort: 7890,
    historyDays: 7
  }
};

const store = new Store({
  defaults,
  encryptionKey: 'token-monitor-local-dev-key'
});

module.exports = store;
```

- [ ] **Step 2: Commit**

```bash
git add src/main/store.js
git commit -m "feat: add electron-store config with defaults and encryption"
```

---

### Task 4: 模型定价配置

**Files:**
- Create: `d:\Deepseek_Monitor\src\main\pricing.js`

- [ ] **Step 1: 创建 pricing.js**

```js
const PRICING = {
  'deepseek-v4-pro': {
    input: 0.001,
    output: 0.004,
    cache_hit: 0.0001
  },
  'deepseek-v4-flash': {
    input: 0.0005,
    output: 0.002,
    cache_hit: 0.00005
  },
  'deepseek-reasoner': {
    input: 0.001,
    output: 0.004,
    cache_hit: 0.0001
  }
};

function getModelPrice(model) {
  if (PRICING[model]) return PRICING[model];
  if (model.startsWith('deepseek-v4-pro')) return PRICING['deepseek-v4-pro'];
  if (model.startsWith('deepseek-v4-flash')) return PRICING['deepseek-v4-flash'];
  if (model.includes('reasoner')) return PRICING['deepseek-reasoner'];
  return PRICING['deepseek-v4-pro'];
}

function calcCost(model, promptTokens, completionTokens, cacheHitTokens) {
  const price = getModelPrice(model);
  const cost =
    (promptTokens / 1000) * price.input +
    (completionTokens / 1000) * price.output +
    (cacheHitTokens / 1000) * price.cache_hit;
  return cost;
}

module.exports = { PRICING, getModelPrice, calcCost };
```

- [ ] **Step 2: Commit**

```bash
git add src/main/pricing.js
git commit -m "feat: add model pricing config and cost calculation"
```

---

### Task 5: 数据聚合器

**Files:**
- Create: `d:\Deepseek_Monitor\src\main\aggregator.js`

- [ ] **Step 1: 创建 aggregator.js**

```js
const fs = require('fs');
const path = require('path');
const { calcCost } = require('./pricing');

const RING_BUFFER_SIZE = 2880;

class Aggregator {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.resetDay();
    this.ringBuffer = new Array(RING_BUFFER_SIZE).fill(null);
    this.bufferIndex = 0;
    this.bufferCount = 0;
    this.currentBucket = { totalTokens: 0, totalCost: 0, timestamp: Date.now() };
    this.loadHistory();
  }

  resetDay() {
    const today = new Date().toISOString().slice(0, 10);
    this.today = {
      date: today,
      models: {},
      totalCost: 0,
      totalTokens: 0,
      totalCacheHit: 0,
      totalCacheMiss: 0,
      totalPromptTokens: 0
    };
  }

  loadHistory() {
    const historyPath = path.join(this.dataDir, 'history.json');
    this.history = [];
    try {
      if (fs.existsSync(historyPath)) {
        this.history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      }
    } catch (e) {
      this.history = [];
    }
  }

  saveHistory() {
    const historyPath = path.join(this.dataDir, 'history.json');
    try {
      fs.writeFileSync(historyPath, JSON.stringify(this.history, null, 2));
    } catch (e) {}
  }

  update(modelName, usage) {
    const date = new Date().toISOString().slice(0, 10);
    if (this.today.date !== date) {
      this.archiveDay();
      this.resetDay();
    }

    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const totalTokens = usage.total_tokens || promptTokens + completionTokens;
    const cacheHit = usage.prompt_cache_hit_tokens || 0;
    const cacheMiss = usage.prompt_cache_miss_tokens || 0;

    if (!this.today.models[modelName]) {
      this.today.models[modelName] = {
        totalTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHit: 0,
        cacheMiss: 0
      };
    }

    const m = this.today.models[modelName];
    m.totalTokens += totalTokens;
    m.promptTokens += promptTokens;
    m.completionTokens += completionTokens;
    m.cacheHit += cacheHit;
    m.cacheMiss += cacheMiss;

    const cost = calcCost(modelName, promptTokens, completionTokens, cacheHit);
    this.today.totalCost += cost;
    this.today.totalTokens += totalTokens;
    this.today.totalCacheHit += cacheHit;
    this.today.totalCacheMiss += cacheMiss;
    this.today.totalPromptTokens += promptTokens;

    this.currentBucket.totalTokens += totalTokens;
    this.currentBucket.totalCost += cost;
  }

  getCacheRate() {
    if (this.today.totalPromptTokens === 0) return 0;
    return this.today.totalCacheHit / this.today.totalPromptTokens * 100;
  }

  getModelStats() {
    const entries = Object.entries(this.today.models)
      .map(([model, data]) => ({ model, ...data }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
    return entries;
  }

  getTodayStats() {
    return {
      models: this.getModelStats(),
      totalCost: this.today.totalCost,
      totalTokens: this.today.totalTokens,
      cacheRate: this.getCacheRate(),
      cacheHit: this.today.totalCacheHit,
      cacheMiss: this.today.totalCacheMiss
    };
  }

  sampleRingBuffer() {
    const bucket = {
      totalTokens: this.currentBucket.totalTokens,
      totalCost: this.currentBucket.totalCost,
      timestamp: this.currentBucket.timestamp
    };
    this.ringBuffer[this.bufferIndex] = bucket;
    this.bufferIndex = (this.bufferIndex + 1) % RING_BUFFER_SIZE;
    if (this.bufferCount < RING_BUFFER_SIZE) this.bufferCount++;
    this.currentBucket = { totalTokens: 0, totalCost: 0, timestamp: Date.now() };
  }

  getRingBufferPoints(count) {
    const points = [];
    const start = (this.bufferIndex - Math.min(count, this.bufferCount) + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
    let cumulativeTokens = 0;
    let cumulativeCost = 0;
    for (let i = 0; i < Math.min(count, this.bufferCount); i++) {
      const idx = (start + i) % RING_BUFFER_SIZE;
      const b = this.ringBuffer[idx];
      if (b) {
        cumulativeTokens += b.totalTokens;
        cumulativeCost += b.totalCost;
        points.push({
          time: b.timestamp,
          totalTokens: cumulativeTokens,
          totalCost: cumulativeCost,
          deltaTokens: b.totalTokens,
          deltaCost: b.totalCost
        });
      }
    }
    return points;
  }

  getPointsForRange(range) {
    switch (range) {
      case '30s': return this.getRingBufferPoints(30);
      case '1m': return this.getRingBufferPoints(60);
      case '1h': return this.downsample(60);
      case '1d': return this.downsample(24);
      default: return this.getRingBufferPoints(60);
    }
  }

  downsample(targetCount) {
    const rawPoints = this.getRingBufferPoints(RING_BUFFER_SIZE);
    if (rawPoints.length <= targetCount) return rawPoints;
    const step = Math.floor(rawPoints.length / targetCount);
    const result = [];
    for (let i = 0; i < rawPoints.length; i += step) {
      const chunk = rawPoints.slice(i, Math.min(i + step, rawPoints.length));
      if (chunk.length === 0) continue;
      const point = {
        time: chunk[chunk.length - 1].time,
        totalTokens: chunk[chunk.length - 1].totalTokens,
        totalCost: chunk[chunk.length - 1].totalCost,
        deltaTokens: chunk.reduce((s, p) => s + p.deltaTokens, 0),
        deltaCost: chunk.reduce((s, p) => s + p.deltaCost, 0)
      };
      result.push(point);
    }
    return result.slice(-targetCount);
  }

  getDailyHistory(days) {
    const todayDate = new Date().toISOString().slice(0, 10);
    const relevant = this.history.filter(h => h.date !== todayDate);
    return relevant.slice(-days);
  }

  archiveDay() {
    this.history.push({
      date: this.today.date,
      models: this.today.models,
      totalCost: this.today.totalCost,
      totalTokens: this.today.totalTokens,
      cacheRate: this.getCacheRate()
    });
    const maxDays = 365;
    if (this.history.length > maxDays) {
      this.history = this.history.slice(-maxDays);
    }
    this.saveHistory();
  }
}

module.exports = Aggregator;
```

- [ ] **Step 2: Commit**

```bash
git add src/main/aggregator.js
git commit -m "feat: add data aggregator with ring buffer and history persistence"
```

---

### Task 6: 余额查询

**Files:**
- Create: `d:\Deepseek_Monitor\src\main\balance.js`

- [ ] **Step 1: 创建 balance.js**

```js
const https = require('https');

function fetchBalance(apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.deepseek.com',
      path: '/user/balance',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.is_available !== undefined && data.balance_infos && data.balance_infos.length > 0) {
            const info = data.balance_infos[0];
            resolve({
              available: data.is_available,
              currency: info.currency,
              total: info.total_balance,
              granted: info.granted_balance,
              toppedUp: info.topped_up_balance
            });
          } else {
            resolve(null);
          }
        } catch (e) {
          reject(new Error('Failed to parse balance response'));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Balance request timeout')); });
    req.end();
  });
}

module.exports = { fetchBalance };
```

- [ ] **Step 2: Commit**

```bash
git add src/main/balance.js
git commit -m "feat: add balance fetcher for DeepSeek API"
```

---

### Task 7: HTTP 代理服务器

**Files:**
- Create: `d:\Deepseek_Monitor\src\main\proxy.js`

- [ ] **Step 1: 创建 proxy.js**

```js
const http = require('http');
const https = require('https');

class ProxyServer {
  constructor(port, apiKey, aggregator, onStatusChange) {
    this.port = port;
    this.apiKey = apiKey;
    this.aggregator = aggregator;
    this.onStatusChange = onStatusChange;
    this.server = null;
    this.running = false;
    this.activeSince = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      if (this.server) this.stop();

      this.server = http.createServer((clientReq, clientRes) => {
        this.handleRequest(clientReq, clientRes);
      });

      this.server.on('error', (err) => {
        this.running = false;
        if (this.onStatusChange) {
          this.onStatusChange({ running: false, port: this.port, error: err.message });
        }
        reject(err);
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.running = true;
        this.activeSince = Date.now();
        if (this.onStatusChange) {
          this.onStatusChange({ running: true, port: this.port, activeSince: this.activeSince });
        }
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.running = false;
          this.server = null;
          if (this.onStatusChange) {
            this.onStatusChange({ running: false, port: this.port });
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  updateApiKey(apiKey) {
    this.apiKey = apiKey;
  }

  handleRequest(clientReq, clientRes) {
    const { method, headers, url } = clientReq;

    const options = {
      hostname: 'api.deepseek.com',
      port: 443,
      path: url,
      method: method,
      headers: { ...headers },
      rejectUnauthorized: true
    };

    delete options.headers.host;
    options.headers['Authorization'] = `Bearer ${this.apiKey}`;

    const proxyReq = https.request(options, (proxyRes) => {
      const isChatCompletion = url && url.includes('/chat/completions');
      let bodyBuffer = isChatCompletion ? [] : null;

      if (isChatCompletion) {
        proxyRes.on('data', (chunk) => {
          bodyBuffer.push(chunk);
          clientRes.write(chunk);
        });
        proxyRes.on('end', () => {
          clientRes.end();
          try {
            const body = Buffer.concat(bodyBuffer).toString();
            const data = JSON.parse(body);
            if (data.usage && data.model) {
              this.aggregator.update(data.model, data.usage);
            }
          } catch (e) {
            // 非 JSON 响应或解析失败，忽略
          }
        });
      } else {
        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(clientRes);
      }
    });

    proxyReq.on('error', (err) => {
      clientRes.writeHead(502);
      clientRes.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
    });

    proxyReq.setTimeout(120000, () => {
      proxyReq.destroy();
      clientRes.writeHead(504);
      clientRes.end(JSON.stringify({ error: 'Upstream timeout' }));
    });

    clientReq.pipe(proxyReq);
  }
}

module.exports = ProxyServer;
```

- [ ] **Step 2: Commit**

```bash
git add src/main/proxy.js
git commit -m "feat: add HTTP proxy server with usage extraction"
```

---

### Task 8: Electron 主进程入口

**Files:**
- Create: `d:\Deepseek_Monitor\src\main\index.js`

- [ ] **Step 1: 创建 index.js**

```js
const { app, BrowserWindow, Tray, Menu, nativeTheme, ipcMain, globalShortcut } = require('electron');
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

  proxyServer.onRequestUpdate = () => {
    if (!mainWindow || !aggregator) return;
    const stats = aggregator.getTodayStats();
    mainWindow.webContents.send('data:update', stats);
  };

  const origHandle = proxyServer.handleRequest.bind(proxyServer);
  proxyServer.handleRequest = (clientReq, clientRes) => {
    const origEnd = clientRes.end;
    origHandle(clientReq, clientRes);
    const origEndBound = clientRes.end.bind(clientRes);
    clientRes.end = function(...args) {
      setTimeout(() => {
        if (mainWindow && aggregator) {
          const stats = aggregator.getTodayStats();
          mainWindow.webContents.send('data:update', stats);
        }
      }, 0);
      return origEndBound(...args);
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
```

- [ ] **Step 2: Commit**

```bash
git add src/main/index.js
git commit -m "feat: add Electron main process with tray, proxy, and service orchestration"
```

---

### Task 9: 设计系统 CSS (DeepSeek 风格)

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\css\main.css`

- [ ] **Step 1: 创建 main.css**

```css
:root {
  --primary: #4D6BFE;
  --primary-light: #7B92FF;
  --primary-dark: #3A50CC;
  --bg-window: rgba(255, 255, 255, 0.92);
  --bg-window-dark: rgba(30, 32, 38, 0.92);
  --bg-card: #F8F9FC;
  --bg-card-dark: #252730;
  --text-primary: #1A1A2E;
  --text-secondary: #6B7280;
  --text-inverse: #FFFFFF;
  --border: #E5E7EB;
  --border-dark: #3A3C45;
  --success: #22C55E;
  --warning: #F59E0B;
  --error: #EF4444;
  --radius-window: 16px;
  --radius-card: 12px;
  --radius-btn: 8px;
  --radius-input: 8px;
  --shadow-window: 0 4px 24px rgba(0, 0, 0, 0.08);
  --shadow-card: 0 2px 8px rgba(0, 0, 0, 0.04);
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
  font-size: 13px;
  color: var(--text-primary);
  background: transparent;
  overflow: hidden;
  user-select: none;
  height: 100vh;
}

#app {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-window);
  border-radius: var(--radius-window);
  box-shadow: var(--shadow-window);
  border: 1px solid var(--border);
  overflow: hidden;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

body.dark #app {
  background: var(--bg-window-dark);
  border-color: var(--border-dark);
  color: #E5E7EB;
}

body.dark {
  --text-primary: #E5E7EB;
  --text-secondary: #9CA3AF;
  --border: #3A3C45;
  --bg-card: #252730;
}

.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  -webkit-app-region: drag;
  flex-shrink: 0;
}

.titlebar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.titlebar-logo {
  font-size: 16px;
  font-weight: 700;
  color: var(--primary);
}

.titlebar-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.titlebar-actions {
  display: flex;
  gap: 4px;
  -webkit-app-region: no-drag;
}

.titlebar-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  transition: all 200ms ease-out;
}

.titlebar-btn:hover {
  background: rgba(77, 107, 254, 0.1);
  color: var(--primary);
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 0 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.content::-webkit-scrollbar {
  width: 4px;
}

.content::-webkit-scrollbar-track {
  background: transparent;
}

.content::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 2px;
}

.statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 14px;
  font-size: 11px;
  color: var(--text-secondary);
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
  margin-right: 4px;
}

.status-dot.online { background: var(--success); }
.status-dot.offline { background: var(--error); }

.component-wrapper {
  background: var(--bg-card);
  border-radius: var(--radius-card);
  padding: 12px;
  border: 1px solid var(--border);
  transition: all 200ms ease-out;
  min-height: 60px;
  position: relative;
}

.component-wrapper.hidden {
  display: none;
}

.component-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
  cursor: grab;
  user-select: none;
}

.component-wrapper.dragging {
  opacity: 0.4;
  border: 2px dashed var(--primary);
}

.component-wrapper.drag-over {
  border-color: var(--primary);
  background: rgba(77, 107, 254, 0.04);
}

.component-title-selector {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.time-select {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  background: var(--bg-card);
  color: var(--text-primary);
  cursor: pointer;
  outline: none;
  transition: all 200ms ease-out;
  font-family: inherit;
}

.time-select:hover {
  border-color: var(--primary);
}

.time-select:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(77, 107, 254, 0.15);
}

.chart-container {
  width: 100%;
  min-height: 120px;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/css/main.css
git commit -m "feat: add DeepSeek design system CSS with light/dark themes"
```

---

### Task 10: 组件样式 CSS

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\css\components.css`

- [ ] **Step 1: 创建 components.css**

```css
.cards-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.card {
  background: linear-gradient(135deg, rgba(77, 107, 254, 0.04), rgba(123, 146, 255, 0.02));
  border-radius: var(--radius-card);
  padding: 12px;
  border: 1px solid var(--border);
  transition: all 200ms ease-out;
  cursor: default;
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-card);
  background: linear-gradient(135deg, rgba(77, 107, 254, 0.08), rgba(123, 146, 255, 0.04));
}

.card-label {
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  font-weight: 500;
}

.card-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
  transition: color 300ms ease-out;
}

.card-value.primary { color: var(--primary); }
.card-value.warning { color: var(--warning); }
.card-value.error { color: var(--error); }

.card-sub {
  font-size: 10px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.model-bar-item {
  display: flex;
  align-items: center;
  padding: 4px 0;
  gap: 8px;
}

.model-bar-label {
  font-size: 11px;
  color: var(--text-primary);
  white-space: nowrap;
  min-width: 70px;
  font-weight: 500;
}

.model-bar-track {
  flex: 1;
  height: 16px;
  background: rgba(77, 107, 254, 0.08);
  border-radius: 8px;
  overflow: hidden;
  position: relative;
}

.model-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary), var(--primary-light));
  border-radius: 8px;
  transition: width 300ms ease-out;
  min-width: 2px;
}

.model-bar-value {
  font-size: 11px;
  color: var(--text-secondary);
  min-width: 60px;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.component-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  cursor: grab;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/css/components.css
git commit -m "feat: add component CSS styles for cards, bars, and charts"
```

---

### Task 11: 设置面板 CSS

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\css\settings.css`

- [ ] **Step 1: 创建 settings.css**

```css
.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 200ms ease-out;
}

.settings-overlay.open {
  opacity: 1;
  pointer-events: auto;
}

.settings-panel {
  width: 360px;
  max-height: 80vh;
  background: var(--bg-card);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-window);
  border: 1px solid var(--border);
  overflow: hidden;
  transform: scale(0.95);
  transition: transform 200ms ease-out;
}

.settings-overlay.open .settings-panel {
  transform: scale(1);
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

.settings-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}

.settings-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
  transition: all 200ms ease-out;
}

.settings-close:hover {
  background: rgba(0, 0, 0, 0.05);
  color: var(--text-primary);
}

.settings-body {
  padding: 16px;
  overflow-y: auto;
  max-height: calc(80vh - 100px);
}

.settings-body::-webkit-scrollbar {
  width: 4px;
}

.settings-body::-webkit-scrollbar-thumb {
  background: var(--border);
  border-radius: 2px;
}

.settings-section {
  margin-bottom: 18px;
}

.settings-section-title {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--text-secondary);
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
}

.setting-row.vertical {
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.setting-label {
  font-size: 13px;
  color: var(--text-primary);
}

.setting-desc {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.toggle-switch {
  position: relative;
  width: 40px;
  height: 22px;
  flex-shrink: 0;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  background: var(--border);
  border-radius: 22px;
  cursor: pointer;
  transition: all 200ms ease-out;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  height: 16px;
  width: 16px;
  left: 3px;
  bottom: 3px;
  background: white;
  border-radius: 50%;
  transition: all 200ms ease-out;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}

.toggle-switch input:checked + .toggle-slider {
  background: var(--primary);
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(18px);
}

.slider-input {
  width: 100%;
  -webkit-appearance: none;
  height: 4px;
  border-radius: 2px;
  background: var(--border);
  outline: none;
}

.slider-input::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--primary);
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(77, 107, 254, 0.3);
}

.slider-value {
  font-size: 12px;
  color: var(--text-secondary);
  margin-left: 8px;
  min-width: 32px;
  text-align: right;
}

.select-input {
  font-size: 13px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  background: var(--bg-card);
  color: var(--text-primary);
  outline: none;
  cursor: pointer;
  font-family: inherit;
  transition: all 200ms ease-out;
}

.select-input:hover {
  border-color: var(--primary);
}

.select-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(77, 107, 254, 0.15);
}

.text-input {
  font-size: 13px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  background: var(--bg-card);
  color: var(--text-primary);
  outline: none;
  font-family: inherit;
  width: 100%;
  transition: all 200ms ease-out;
}

.text-input:hover {
  border-color: var(--primary);
}

.text-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px rgba(77, 107, 254, 0.15);
}

.settings-footer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  justify-content: flex-end;
}

.btn {
  font-size: 13px;
  padding: 6px 16px;
  border-radius: var(--radius-btn);
  border: none;
  cursor: pointer;
  font-family: inherit;
  font-weight: 500;
  transition: all 200ms ease-out;
}

.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.btn-secondary:hover {
  background: rgba(0, 0, 0, 0.03);
  color: var(--text-primary);
}

.btn-primary {
  background: var(--primary);
  color: var(--text-inverse);
}

.btn-primary:hover {
  background: var(--primary-light);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/css/settings.css
git commit -m "feat: add settings panel CSS with toggles, sliders, and modals"
```

---

### Task 12: 登录窗口页面

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\login.html`

- [ ] **Step 1: 创建 login.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DeepSeek Monitor - 登录</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
    font-size: 13px;
    background: transparent;
    overflow: hidden;
    height: 100vh;
    display: flex;
  }
  .container {
    width: 100%;
    height: 100%;
    background: rgba(255, 255, 255, 0.95);
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
    display: flex;
    flex-direction: column;
    padding: 32px 28px;
  }
  .logo {
    font-size: 20px;
    font-weight: 700;
    color: #4D6BFE;
    margin-bottom: 4px;
    text-align: center;
  }
  .subtitle {
    font-size: 12px;
    color: #6B7280;
    text-align: center;
    margin-bottom: 24px;
  }
  .form-group { margin-bottom: 16px; }
  .form-label {
    font-size: 12px;
    font-weight: 600;
    color: #1A1A2E;
    margin-bottom: 6px;
    display: block;
  }
  .form-input {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid #E5E7EB;
    border-radius: 8px;
    font-size: 13px;
    color: #1A1A2E;
    background: #F8F9FC;
    outline: none;
    font-family: monospace;
    transition: all 200ms ease-out;
  }
  .form-input:focus {
    border-color: #4D6BFE;
    box-shadow: 0 0 0 2px rgba(77, 107, 254, 0.15);
  }
  .form-hint {
    font-size: 11px;
    color: #9CA3AF;
    margin-top: 4px;
  }
  .error-msg {
    font-size: 11px;
    color: #EF4444;
    margin-top: 4px;
    min-height: 16px;
  }
  .btn-row {
    display: flex;
    gap: 8px;
    margin-top: auto;
  }
  .btn {
    flex: 1;
    padding: 10px 0;
    border-radius: 8px;
    border: none;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: all 200ms ease-out;
  }
  .btn-primary {
    background: #4D6BFE;
    color: #FFFFFF;
  }
  .btn-primary:hover { background: #7B92FF; }
  .btn-primary:disabled { background: #9CA3AF; cursor: not-allowed; }
  .btn-secondary {
    background: transparent;
    color: #6B7280;
    border: 1px solid #E5E7EB;
  }
  .btn-secondary:hover { background: rgba(0, 0, 0, 0.03); }
</style>
</head>
<body>
<div class="container">
  <div class="logo"> DeepSeek Monitor</div>
  <div class="subtitle">连接到您的 DeepSeek 账户以开始监控</div>

  <div class="form-group">
    <label class="form-label">API Key</label>
    <input type="password" class="form-input" id="apiKeyInput" placeholder="sk-xxxxxxxxxxxxxxxx"
           autocomplete="off" autofocus>
    <div class="form-hint">在 platform.deepseek.com/api_keys 获取</div>
    <div class="error-msg" id="errorMsg"></div>
  </div>

  <div class="btn-row">
    <button class="btn btn-secondary" id="skipBtn">跳过</button>
    <button class="btn btn-primary" id="loginBtn">验证并登录</button>
  </div>
</div>
<script src="js/login.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建 login.js**

```js
const apiKeyInput = document.getElementById('apiKeyInput');
const loginBtn = document.getElementById('loginBtn');
const skipBtn = document.getElementById('skipBtn');
const errorMsg = document.getElementById('errorMsg');

loginBtn.addEventListener('click', () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    errorMsg.textContent = '请输入 API Key';
    return;
  }
  if (!apiKey.startsWith('sk-')) {
    errorMsg.textContent = 'API Key 格式不正确，应以 sk- 开头';
    return;
  }
  loginBtn.disabled = true;
  loginBtn.textContent = '验证中...';
  errorMsg.textContent = '';
  window.api.send('login:submit', { apiKey });
});

window.api.on('login:error', (msg) => {
  errorMsg.textContent = msg;
  loginBtn.disabled = false;
  loginBtn.textContent = '验证并登录';
});

skipBtn.addEventListener('click', () => {
  window.api.send('window:close');
});

apiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginBtn.click();
});
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/login.html
git commit -m "feat: add login window page"
```

---

### Task 13: ECharts 主题配置

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\js\charts.js`

- [ ] **Step 1: 创建 charts.js**

```js
const echarts = require('echarts');

function getTheme(isDark) {
  return {
    color: ['#4D6BFE', '#22C55E', '#F59E0B', '#EF4444', '#7B92FF'],
    backgroundColor: 'transparent',
    textStyle: {
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 10,
      color: isDark ? '#9CA3AF' : '#6B7280'
    },
    grid: {
      top: 12,
      right: 12,
      bottom: 8,
      left: 40,
      containLabel: false
    },
    xAxis: {
      type: 'time',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 9,
        color: isDark ? '#9CA3AF' : '#6B7280',
        formatter: (value) => {
          const d = new Date(value);
          return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
        }
      },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 9,
        color: isDark ? '#9CA3AF' : '#6B7280'
      },
      splitLine: {
        lineStyle: {
          color: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
          type: 'dashed'
        }
      }
    },
    tooltip: {
      backgroundColor: isDark ? 'rgba(30,32,38,0.95)' : 'rgba(255,255,255,0.95)',
      borderColor: isDark ? '#3A3C45' : '#E5E7EB',
      textStyle: {
        color: isDark ? '#E5E7EB' : '#1A1A2E',
        fontSize: 11
      }
    }
  };
}

function parseTokenValue(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;
  const num = parseInt(value, 10);
  return isNaN(num) ? 0 : num;
}

module.exports = { getTheme, parseTokenValue };
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/js/charts.js
git commit -m "feat: add ECharts theme config with light/dark support"
```

---

### Task 14: 费用概览卡片组件

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\js\components\fee-cards.js`

- [ ] **Step 1: 创建 fee-cards.js**

```js
function getBalanceClass(totalBalance) {
  const val = parseFloat(totalBalance);
  if (isNaN(val)) return 'primary';
  if (val < 5) return 'error';
  if (val < 20) return 'warning';
  return 'primary';
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function updateFeeCards(balanceData, statsData) {
  const container = document.getElementById('fee-cards');
  if (!container) return;

  let balanceHTML = '<div class="card-label">余额</div>';
  let costHTML = '<div class="card-label">今日消耗</div>';
  let cacheHTML = '<div class="card-label">缓存命中率</div>';

  if (balanceData) {
    const cls = getBalanceClass(balanceData.total);
    balanceHTML += `<div class="card-value ${cls}">&yen;${balanceData.total || '--'}</div>`;
    balanceHTML += `<div class="card-sub">充值 ${balanceData.toppedUp || '--'} | 赠金 ${balanceData.granted || '--'}</div>`;
  } else {
    balanceHTML += '<div class="card-value primary">--</div>';
  }

  if (statsData) {
    costHTML += `<div class="card-value primary">&yen;${statsData.totalCost.toFixed(4)}</div>`;
    costHTML += `<div class="card-sub">${formatTokens(statsData.totalTokens)} tokens</div>`;

    const rate = statsData.cacheRate.toFixed(1);
    cacheHTML += `<div class="card-value primary">${rate}%</div>`;
    cacheHTML += `<div class="card-sub">命中 ${formatTokens(statsData.cacheHit)} | 未命中 ${formatTokens(statsData.cacheMiss)}</div>`;
  } else {
    costHTML += '<div class="card-value primary">--</div>';
    cacheHTML += '<div class="card-value primary">--</div>';
  }

  container.innerHTML = `
    <div class="cards-row">
      <div class="card">${balanceHTML}</div>
      <div class="card">${costHTML}</div>
      <div class="card">${cacheHTML}</div>
    </div>
  `;
}

module.exports = { updateFeeCards };
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/js/components/fee-cards.js
git commit -m "feat: add fee cards component with balance warning colors"
```

---

### Task 15: 模型消耗柱状图组件

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\js\components\model-bar.js`

- [ ] **Step 1: 创建 model-bar.js**

```js
function updateModelBar(models) {
  const container = document.getElementById('model-bar');
  if (!container) return;

  if (!models || models.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:8px;">暂无数据</div>';
    return;
  }

  const maxTokens = models[0]?.totalTokens || 1;

  let html = '';
  models.forEach(m => {
    const pct = Math.max((m.totalTokens / maxTokens) * 100, 2);
    const modelName = m.model.replace('deepseek-', '');
    let tokenDisplay;
    if (m.totalTokens >= 1000000) {
      tokenDisplay = (m.totalTokens / 1000000).toFixed(1) + 'M';
    } else if (m.totalTokens >= 1000) {
      tokenDisplay = (m.totalTokens / 1000).toFixed(1) + 'K';
    } else {
      tokenDisplay = m.totalTokens.toString();
    }
    html += `
      <div class="model-bar-item">
        <span class="model-bar-label">${modelName}</span>
        <div class="model-bar-track">
          <div class="model-bar-fill" style="width:${pct}%"></div>
        </div>
        <span class="model-bar-value">${tokenDisplay} tk</span>
      </div>
    `;
  });

  container.innerHTML = html;
}

module.exports = { updateModelBar };
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/js/components/model-bar.js
git commit -m "feat: add model bar chart component"
```

---

### Task 16: Token 增长趋势折线图组件

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\js\components\token-line.js`

- [ ] **Step 1: 创建 token-line.js**

```js
const echarts = require('echarts');
const { getTheme } = require('../charts');

let tokenChart = null;
let tokenChartDom = null;

function initTokenChart(containerId) {
  const dom = document.getElementById(containerId);
  if (!dom) return;
  tokenChartDom = dom;
  const isDark = document.body.classList.contains('dark');
  tokenChart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });
  tokenChart.setOption({
    ...getTheme(isDark),
    animation: false,
    series: [
      {
        name: '累计 Token',
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { color: '#4D6BFE', width: 1.5 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(77,107,254,0.15)' },
            { offset: 1, color: 'rgba(77,107,254,0)' }
          ])
        },
        data: []
      },
      {
        name: '增量 Token',
        type: 'bar',
        barWidth: 2,
        itemStyle: { color: 'rgba(77,107,254,0.35)' },
        data: []
      }
    ]
  });

  window.addEventListener('resize', () => {
    if (tokenChart && tokenChartDom) {
      tokenChart.resize({ width: tokenChartDom.clientWidth, height: tokenChartDom.clientHeight });
    }
  });
}

function updateTokenChart(points) {
  if (!tokenChart) return;

  const totalData = points.map(p => [p.time, p.totalTokens || 0]);
  const deltaData = points.map(p => [p.time, p.deltaTokens || 0]);

  tokenChart.setOption({
    series: [
      { data: totalData },
      { data: deltaData }
    ]
  });
}

function resizeTokenChart() {
  if (tokenChart && tokenChartDom) {
    tokenChart.resize({ width: tokenChartDom.clientWidth, height: tokenChartDom.clientHeight });
  }
}

function disposeTokenChart() {
  if (tokenChart) {
    tokenChart.dispose();
    tokenChart = null;
    tokenChartDom = null;
  }
}

module.exports = { initTokenChart, updateTokenChart, resizeTokenChart, disposeTokenChart };
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/js/components/token-line.js
git commit -m "feat: add token line chart component with ECharts"
```

---

### Task 17: 费用增长趋势折线图组件

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\js\components\cost-line.js`

- [ ] **Step 1: 创建 cost-line.js**

```js
const echarts = require('echarts');
const { getTheme } = require('../charts');

let costChart = null;
let costChartDom = null;

function initCostChart(containerId) {
  const dom = document.getElementById(containerId);
  if (!dom) return;
  costChartDom = dom;
  const isDark = document.body.classList.contains('dark');
  costChart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });
  costChart.setOption({
    ...getTheme(isDark),
    animation: false,
    series: [
      {
        name: '累计费用',
        type: 'line',
        smooth: true,
        showSymbol: false,
        lineStyle: { color: '#22C55E', width: 1.5 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(34,197,94,0.15)' },
            { offset: 1, color: 'rgba(34,197,94,0)' }
          ])
        },
        data: []
      },
      {
        name: '增量费用',
        type: 'bar',
        barWidth: 2,
        itemStyle: { color: 'rgba(34,197,94,0.35)' },
        data: []
      }
    ]
  });

  window.addEventListener('resize', () => {
    if (costChart && costChartDom) {
      costChart.resize({ width: costChartDom.clientWidth, height: costChartDom.clientHeight });
    }
  });
}

function updateCostChart(points) {
  if (!costChart) return;

  const totalData = points.map(p => [p.time, p.totalCost || 0]);
  const deltaData = points.map(p => [p.time, p.deltaCost || 0]);

  costChart.setOption({
    series: [
      { data: totalData },
      { data: deltaData }
    ]
  });
}

function resizeCostChart() {
  if (costChart && costChartDom) {
    costChart.resize({ width: costChartDom.clientWidth, height: costChartDom.clientHeight });
  }
}

function disposeCostChart() {
  if (costChart) {
    costChart.dispose();
    costChart = null;
    costChartDom = null;
  }
}

module.exports = { initCostChart, updateCostChart, resizeCostChart, disposeCostChart };
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/js/components/cost-line.js
git commit -m "feat: add cost line chart component with ECharts"
```

---

### Task 18: 设置面板交互逻辑

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\js\settings.js`

- [ ] **Step 1: 创建 settings.js**

```js
let debounceTimer = null;

let settingsDefinitions = [
  { group: '窗口', key: 'window.opacity', type: 'slider', label: '透明度', min: 20, max: 100, default: 92, unit: '%' },
  { group: '窗口', key: 'window.alwaysOnTop', type: 'toggle', label: '始终置顶', default: true },
  { group: '窗口', key: 'window.autoLaunch', type: 'toggle', label: '开机自启', default: false },
  { group: '窗口', key: 'window.followSystemTheme', type: 'toggle', label: '跟随系统主题', default: true },
  { group: '窗口', key: 'window.layoutLocked', type: 'toggle', label: '锁定布局', default: true },
  { group: '组件', key: 'components.feeCards', type: 'toggle', label: '费用概览卡片', default: true },
  { group: '组件', key: 'components.modelBar', type: 'toggle', label: '模型消耗柱状图', default: true },
  { group: '组件', key: 'components.tokenLine', type: 'toggle', label: 'Token 增长趋势', default: true },
  { group: '组件', key: 'components.costLine', type: 'toggle', label: '费用增长趋势', default: true },
  { group: '数据', key: 'data.sampleInterval', type: 'select', label: '曲线采样频率', options: [
    { value: 30, label: '30 秒' },
    { value: 60, label: '1 分钟' }
  ], default: 30 },
  { group: '数据', key: 'data.defaultTimeRange', type: 'select', label: '默认时间维度', options: [
    { value: '30s', label: '30 秒' },
    { value: '1m', label: '分钟' },
    { value: '1h', label: '小时' },
    { value: '1d', label: '天' }
  ], default: '1m' },
  { group: '数据', key: 'data.proxyPort', type: 'text', label: '代理端口', default: 7890 },
  { group: '数据', key: 'data.historyDays', type: 'select', label: '历史数据保留', options: [
    { value: 3, label: '3 天' },
    { value: 7, label: '7 天' },
    { value: 30, label: '30 天' }
  ], default: 7 },
  { group: '关于', key: 'apiKey', type: 'password', label: 'API Key', default: '' }
];

function getValue(key) {
  return window._settingsData ? getNested(window._settingsData, key) : undefined;
}

function getNested(obj, path) {
  if (!obj) return undefined;
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function renderSetting(def, currentValue) {
  const val = currentValue !== undefined ? currentValue : def.default;
  let input;

  switch (def.type) {
    case 'toggle':
      input = `<label class="toggle-switch">
        <input type="checkbox" data-key="${def.key}" ${val ? 'checked' : ''}>
        <span class="toggle-slider"></span>
      </label>`;
      break;
    case 'slider':
      input = `<div style="display:flex;align-items:center;flex:1;">
        <input type="range" class="slider-input" data-key="${def.key}" min="${def.min}" max="${def.max}" value="${val}" style="flex:1;">
        <span class="slider-value">${val}${def.unit || ''}</span>
      </div>`;
      break;
    case 'select':
      input = `<select class="select-input" data-key="${def.key}">
        ${def.options.map(o => `<option value="${o.value}" ${String(val) === String(o.value) ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>`;
      break;
    case 'text':
      input = `<input type="text" class="text-input" data-key="${def.key}" value="${val}">`;
      break;
    case 'password':
      input = `<input type="password" class="text-input" data-key="${def.key}" value="${val}">`;
      break;
    default:
      input = '';
  }

  return `<div class="setting-row${def.type === 'slider' ? ' vertical' : ''}">
    <div><span class="setting-label">${def.label}</span></div>
    ${input}
  </div>`;
}

function renderSettingsPanel() {
  const groups = {};
  settingsDefinitions.forEach(def => {
    if (!groups[def.group]) groups[def.group] = [];
    groups[def.group].push(def);
  });

  let bodyHTML = '';
  Object.entries(groups).forEach(([group, defs]) => {
    bodyHTML += `<div class="settings-section">
      <div class="settings-section-title">${group}</div>
      ${defs.map(d => renderSetting(d, getValue(d.key))).join('')}
    </div>`;
  });

  return `
    <div class="settings-overlay" id="settingsOverlay">
      <div class="settings-panel">
        <div class="settings-header">
          <span class="settings-title">设置</span>
          <button class="settings-close" id="settingsCloseBtn">&times;</button>
        </div>
        <div class="settings-body">${bodyHTML}</div>
        <div class="settings-footer">
          <button class="btn btn-secondary" id="resetBtn">恢复默认</button>
          <button class="btn btn-primary" id="settingsDoneBtn">关闭</button>
        </div>
      </div>
    </div>
  `;
}

function initSettings() {
  document.getElementById('settingsBtn').addEventListener('click', openSettings);

  window.api.invoke('get:settings').then(settings => {
    window._settingsData = settings;
    injectSettingsPanel();
  });
}

function injectSettingsPanel() {
  const existing = document.getElementById('settingsOverlay');
  if (existing) existing.remove();

  const html = renderSettingsPanel();
  document.body.insertAdjacentHTML('beforeend', html);
  bindSettingsEvents();
}

function bindSettingsEvents() {
  const overlay = document.getElementById('settingsOverlay');
  if (!overlay) return;

  document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
  document.getElementById('settingsDoneBtn').addEventListener('click', closeSettings);

  document.getElementById('resetBtn').addEventListener('click', () => {
    window.api.send('settings:reset');
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSettings();
  });

  overlay.querySelectorAll('input[data-key], select[data-key]').forEach(el => {
    el.addEventListener('input', () => {
      const key = el.dataset.key;
      let value;
      if (el.type === 'checkbox') {
        value = el.checked;
      } else if (el.type === 'range') {
        value = parseInt(el.value, 10);
        const valSpan = el.parentElement.querySelector('.slider-value');
        if (valSpan) {
          const def = settingsDefinitions.find(d => d.key === key);
          valSpan.textContent = value + (def ? (def.unit || '') : '');
        }
      } else if (el.value && !isNaN(el.value) && key === 'data.proxyPort') {
        value = parseInt(el.value, 10);
      } else {
        value = el.value;
      }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        window.api.send('settings:update', { key, value });
        applyUISetting(key, value);
      }, 300);
    });

    if (el.type === 'checkbox') {
      el.addEventListener('change', () => {
        const key = el.dataset.key;
        const value = el.checked;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          window.api.send('settings:update', { key, value });
          applyUISetting(key, value);
        }, 300);
      });
    }
  });
}

function applyUISetting(key, value) {
  switch (key) {
    case 'components.feeCards':
      document.getElementById('fee-cards')?.classList.toggle('hidden', !value);
      break;
    case 'components.modelBar':
      document.getElementById('model-bar')?.classList.toggle('hidden', !value);
      break;
    case 'components.tokenLine':
      document.getElementById('token-line')?.classList.toggle('hidden', !value);
      break;
    case 'components.costLine':
      document.getElementById('cost-line')?.classList.toggle('hidden', !value);
      break;
    case 'window.layoutLocked':
      setLayoutLocked(value);
      break;
  }
}

let isLayoutLocked = true;

function setLayoutLocked(locked) {
  isLayoutLocked = locked;
  document.querySelectorAll('.component-title').forEach(el => {
    el.draggable = !locked;
    el.style.cursor = locked ? 'default' : 'grab';
  });
}

function openSettings() {
  const overlay = document.getElementById('settingsOverlay');
  if (overlay) {
    overlay.classList.add('open');
  } else {
    injectSettingsPanel();
    setTimeout(() => document.getElementById('settingsOverlay')?.classList.add('open'), 10);
  }
}

function closeSettings() {
  const overlay = document.getElementById('settingsOverlay');
  if (overlay) overlay.classList.remove('open');
}

module.exports = { initSettings, openSettings, closeSettings };
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/js/settings.js
git commit -m "feat: add settings panel with dynamic rendering and debounced IPC"
```

---

### Task 19: 组件拖拽排序

**Files:**
- Modify: `d:\Deepseek_Monitor\src\renderer\js\app.js` (创建时包含)

这里将拖拽排序逻辑作为独立模块。

- [ ] **Step 1: 创建 drag-sort.js**

Create: `d:\Deepseek_Monitor\src\renderer\js\components\drag-sort.js`

```js
let longPressTimer = null;
let draggedEl = null;

function initDragSort(containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;

  container.addEventListener('mousedown', (e) => {
    const title = e.target.closest('.component-title');
    if (!title) return;
    if (isLayoutLocked) return;

    const wrapper = title.closest('.component-wrapper');
    if (!wrapper) return;

    longPressTimer = setTimeout(() => {
      wrapper.classList.add('dragging');
      wrapper.draggable = true;
      wrapper.setAttribute('draggable', 'true');
      draggedEl = wrapper;
      wrapper.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
    }, 200);
  });

  container.addEventListener('mouseup', () => {
    clearTimeout(longPressTimer);
    if (draggedEl) {
      draggedEl.classList.remove('dragging');
      draggedEl.setAttribute('draggable', 'false');
      draggedEl = null;
    }
  });

  container.addEventListener('mouseleave', () => {
    clearTimeout(longPressTimer);
    if (draggedEl) {
      draggedEl.classList.remove('dragging');
      draggedEl.setAttribute('draggable', 'false');
      draggedEl = null;
    }
  });

  container.addEventListener('dragstart', (e) => {
    if (!isLayoutLocked && draggedEl) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedEl.id);
      setTimeout(() => { draggedEl.classList.add('dragging'); }, 0);
    } else {
      e.preventDefault();
    }
  });

  container.addEventListener('dragend', (e) => {
    if (draggedEl) {
      draggedEl.classList.remove('dragging');
      draggedEl = null;
    }
    container.querySelectorAll('.component-wrapper').forEach(w => w.classList.remove('drag-over'));
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.component-wrapper');
    if (target && target !== draggedEl) {
      container.querySelectorAll('.component-wrapper').forEach(w => w.classList.remove('drag-over'));
      target.classList.add('drag-over');
    }
  });

  container.addEventListener('dragleave', (e) => {
    const target = e.target.closest('.component-wrapper');
    if (target) target.classList.remove('drag-over');
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    container.querySelectorAll('.component-wrapper').forEach(w => w.classList.remove('drag-over'));

    const target = e.target.closest('.component-wrapper');
    if (!target || target === draggedEl || !draggedEl) return;

    const wrappers = [...container.querySelectorAll('.component-wrapper')];
    const fromIndex = wrappers.indexOf(draggedEl);
    const toIndex = wrappers.indexOf(target);

    if (fromIndex < toIndex) {
      container.insertBefore(draggedEl, target.nextSibling);
    } else {
      container.insertBefore(draggedEl, target);
    }

    saveComponentOrder(container);
  });
}

function saveComponentOrder(container) {
  const wrappers = container.querySelectorAll('.component-wrapper');
  const order = [...wrappers].map(w => w.id);
  window.api.send('settings:update', { key: 'componentOrder', value: order });
}

module.exports = { initDragSort };
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/js/components/drag-sort.js
git commit -m "feat: add drag-and-drop component reordering"
```

---

### Task 20: 渲染进程主入口 + 组件编排

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\js\app.js`

- [ ] **Step 1: 创建 app.js**

```js
const { updateFeeCards } = require('./components/fee-cards');
const { updateModelBar } = require('./components/model-bar');
const { initTokenChart, updateTokenChart, resizeTokenChart, disposeTokenChart } = require('./components/token-line');
const { initCostChart, updateCostChart, resizeCostChart, disposeCostChart } = require('./components/cost-line');
const { initDragSort } = require('./components/drag-sort');
const { initSettings, openSettings } = require('./settings');

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('minimizeBtn').addEventListener('click', () => {
    window.api.send('window:minimize');
  });

  document.getElementById('closeBtn').addEventListener('click', () => {
    window.api.send('window:minimize');
  });

  document.getElementById('settingsBtn').addEventListener('click', () => {
    openSettings();
  });

  initDragSort('.content');

  window.api.invoke('get:settings').then(settings => {
    window._settingsData = settings;
    applyComponentVisibility(settings);
    initSettings();

    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark && settings.window?.followSystemTheme !== false) {
      document.body.classList.add('dark');
    }

    initTokenChart('token-chart');
    initCostChart('cost-chart');
  });

  window.api.on('data:update', (stats) => {
    updateFeeCards(null, stats);
    if (stats.models) updateModelBar(stats.models);
  });

  window.api.on('balance:update', (balance) => {
    const lastStats = window._lastStats;
    updateFeeCards(balance, lastStats);
  });

  window.api.on('curve:token', ({ points }) => {
    updateTokenChart(points);
  });

  window.api.on('curve:cost', ({ points }) => {
    updateCostChart(points);
  });

  window.api.on('proxy:status', (status) => {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const portSpan = document.getElementById('proxyPort');

    if (status.running) {
      dot.className = 'status-dot online';
      text.textContent = '代理运行中';
    } else {
      dot.className = 'status-dot offline';
      text.textContent = status.error ? `错误: ${status.error}` : '代理已停止';
    }

    if (portSpan && status.port) {
      portSpan.textContent = `localhost:${status.port}`;
    }
  });

  window.api.on('settings:loaded', (settings) => {
    window._settingsData = settings;
    applyComponentVisibility(settings);
  });

  window.api.on('open:settings', () => {
    openSettings();
  });

  window.api.on('theme:changed', (theme) => {
    if (theme === 'dark') {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
    disposeTokenChart();
    disposeCostChart();
    initTokenChart('token-chart');
    initCostChart('cost-chart');
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (window._settingsData?.window?.followSystemTheme !== false) {
      if (e.matches) {
        document.body.classList.add('dark');
      } else {
        document.body.classList.remove('dark');
      }
      disposeTokenChart();
      disposeCostChart();
      initTokenChart('token-chart');
      initCostChart('cost-chart');
    }
  });

  window.addEventListener('resize', () => {
    resizeTokenChart();
    resizeCostChart();
  });
});

function applyComponentVisibility(settings) {
  if (settings?.components?.feeCards === false) {
    document.getElementById('fee-cards')?.classList.add('hidden');
  }
  if (settings?.components?.modelBar === false) {
    document.getElementById('model-bar')?.classList.add('hidden');
  }
  if (settings?.components?.tokenLine === false) {
    document.getElementById('token-line')?.classList.add('hidden');
  }
  if (settings?.components?.costLine === false) {
    document.getElementById('cost-line')?.classList.add('hidden');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/js/app.js
git commit -m "feat: add renderer entry with IPC listeners and component orchestration"
```

---

### Task 21: 悬浮窗主页面 HTML

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\index.html`

- [ ] **Step 1: 创建 index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DeepSeek Monitor</title>
<link rel="stylesheet" href="css/main.css">
<link rel="stylesheet" href="css/components.css">
<link rel="stylesheet" href="css/settings.css">
</head>
<body>
<div id="app">
  <div class="titlebar">
    <div class="titlebar-left">
      <span class="titlebar-logo"> </span>
      <span class="titlebar-text">DeepSeek Monitor</span>
    </div>
    <div class="titlebar-actions">
      <button class="titlebar-btn" id="settingsBtn" title="设置"> </button>
      <button class="titlebar-btn" id="minimizeBtn" title="最小化">&#x2014;</button>
      <button class="titlebar-btn" id="closeBtn" title="关闭">&times;</button>
    </div>
  </div>

  <div class="content">
    <div class="component-wrapper" id="fee-cards"></div>
    <div class="component-wrapper" id="model-bar">
      <div class="component-title">模型消耗</div>
    </div>
    <div class="component-wrapper" id="token-line">
      <div class="component-header">
        <div class="component-title">Token 增长趋势</div>
        <select class="time-select" id="tokenTimeRange">
          <option value="30s">30 秒</option>
          <option value="1m" selected>分钟</option>
          <option value="1h">小时</option>
          <option value="1d">天</option>
        </select>
      </div>
      <div class="chart-container" id="token-chart"></div>
    </div>
    <div class="component-wrapper" id="cost-line">
      <div class="component-header">
        <div class="component-title">费用增长趋势</div>
        <select class="time-select" id="costTimeRange">
          <option value="30s">30 秒</option>
          <option value="1m" selected>分钟</option>
          <option value="1h">小时</option>
          <option value="1d">天</option>
        </select>
      </div>
      <div class="chart-container" id="cost-chart"></div>
    </div>
  </div>

  <div class="statusbar">
    <div style="display:flex;align-items:center;">
      <span class="status-dot online" id="statusDot"></span>
      <span id="statusText">代理未启动</span>
    </div>
    <span id="proxyPort">localhost:7890</span>
    <span id="apiKeyDisplay">--</span>
  </div>
</div>
<script src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat: add main widget window HTML with all component containers"
```

---

### Task 22: 资源文件 & 最终集成

**Files:**
- Create: `d:\Deepseek_Monitor\src\renderer\assets\icon.png` (应用图标，见下方说明)
- Create: `d:\Deepseek_Monitor\src\renderer\assets\tray-icon.png` (托盘图标，见下方说明)
- Create: `d:\Deepseek_Monitor\assets\icon.ico` (Windows 图标)

- [ ] **Step 1: 生成图标占位文件**

使用 PowerShell 创建简易的 PNG 占位图标（1x1 像素蓝色，后续可替换为正式图标）：

```powershell
# 创建 assets 目录
New-Item -ItemType Directory -Force -Path "d:\Deepseek_Monitor\src\renderer\assets"
New-Item -ItemType Directory -Force -Path "d:\Deepseek_Monitor\assets"

# 创建简单的 16x16 PNG 托盘图标（最小有效 PNG）
# 使用 Node.js 生成占位图标
node -e "
const fs = require('fs');
const path = require('path');

// Minimal valid 16x16 blue PNG (base64 encoded)
// This is a placeholder; replace with real DeepSeek whale logo
const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2NkYPj/n4EBBJgYKAQMowYMDAyjBgAD3Y4YNWCkARg1YNSAUTpg1AAGAHLbBx4kEgAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync(path.join('src/renderer/assets/tray-icon.png'), png1x1);
fs.writeFileSync(path.join('src/renderer/assets/icon.png'), png1x1);

// For .ico, use a simple approach - copy png for now
fs.copyFileSync(path.join('src/renderer/assets/icon.png'), path.join('assets/icon.ico'));
console.log('Placeholder icons created. Replace with real DeepSeek branding.');
"
```

- [ ] **Step 2: 验证项目结构**

```powershell
cd d:\Deepseek_Monitor
dir src\main\*.js
dir src\renderer\js\components\*.js
dir src\preload\*.js
```

- [ ] **Step 3: 启动测试**

```powershell
npm start
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/assets/ assets/ -f
git commit -m "chore: add placeholder icons and finalize project structure"
```

---

## 验证清单

实施完成后，逐项验证：

- [ ] `npm start` 正常启动，无报错
- [ ] 首次启动显示登录窗口
- [ ] 输入有效 API Key 后，登录窗口关闭，悬浮窗显示
- [ ] 余额卡片显示正确数值和颜色（≥¥20 蓝色，¥5-20 黄色，<¥5 红色）
- [ ] 代理运行中，状态栏绿点显示
- [ ] 发送 API 请求到 localhost:7890，柱状图和卡片实时更新
- [ ] Token/费用曲线图每 30s 更新一次
- [ ] 设置面板打开/关闭流畅，修改透明度即时生效
- [ ] 开关组件可见性，布局自适应
- [ ] 解锁布局后长按组件标题可拖拽排序
- [ ] 始终置顶正常工作
- [ ] 系统托盘图标显示，右键菜单可用
- [ ] 关闭窗口后隐藏到托盘，双击托盘图标恢复
