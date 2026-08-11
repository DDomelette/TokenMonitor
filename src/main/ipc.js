// 主进程 IPC 模块:全部 ipcMain 处理器 + 缩放状态机。
// 依赖由 index.js 注入(deps),窗口创建/生命周期仍留在 index.js。
const { ipcMain, BrowserWindow } = require('electron');
const { buildHeatmap } = require('./core/heatmap');
const { sanitizeSettings, isWritableSettingKey, resolveWritableSettingKey } = require('./core/settings-security');
const { resetSettingsStore } = require('./core/settings-reset');
const { saveSetting } = require('./core/settings-write');
const { replaceDeepseekApiKey } = require('./core/api-key-replacement');
const { filterUsageDaily, retentionStartDay } = require('./core/usage-retention');
const { getSessionSnapshot } = require('./core/session-state');
const { skipDeepseekLogin } = require('./core/startup-windows');
const { syncDeepSeekHistory, rescanLocalLogs } = require('./core/history-sync');
const { UsageFetcher } = require('./providers/deepseek/usage');
const { httpGet } = require('./core/http');
const { SYSTEM_PROXY_VALUE, resolveElectronSystemProxy } = require('./core/proxy-settings');
const { registerDiagnosticsIpc } = require('./core/diagnostics/ipc-registration');
const { detectProxyPort } = require('./core/proxy-detect');

function deepseekApiKeyCtx(deps, apiKey) {
  return {
    store: {
      get: (k) => (k === 'providers.deepseek.apiKey' ? apiKey : deps.store.get(k)),
      set: (k, v) => deps.store.set(k, v),
      delete: (k) => deps.store.delete(k)
    },
    logger: console,
    getProxyUrl: () => deps.store.get('providers.proxyUrl') || null
  };
}

module.exports = function setupIPC(deps) {
  let mainResizeState = null;
  let settingsResizeState = null;

  registerDiagnosticsIpc({
    ipcMain,
    diagnostics: deps.diagnostics,
    getDiagnosticsWindow: deps.getDiagnosticsWindow,
    createDiagnosticsWindow: deps.createDiagnosticsWindow
  });

  function getMain() {
    return deps.getMainWindow();
  }

  function getSettings() {
    return deps.getSettingsWindow();
  }

  function buildDashboardPayload(providerId) {
    const pid = providerId || 'deepseek';
    const st = deps.scheduler.getState(pid) || {};
    const payload = { providerId: pid, balance: st.balance || null };
    if (pid === 'deepseek' && st.usage) {
      const stats = {
        cost: st.usage.cost.aggregate,
        token: st.usage.amount.aggregate,
        costDaily: st.usage.cost.dailyData,
        tokenDaily: st.usage.amount.dailyData
      };
      payload.stats = stats;
      const curves = deps.buildCurvePoints(stats);
      payload.curveToken = curves.token;
      payload.curveCost = curves.cost;
    }
    return payload;
  }

  /* ======== 登录 ======== */

  ipcMain.on('login:submit', async (event, { apiKey }) => {
    const main = getMain();
    try {
      const deepseek = deps.registry.get('deepseek');
      const info = await deepseek.fetchBalance(deepseekApiKeyCtx(deps, apiKey));
      if (!info) throw new Error('API Key 验证失败');
      deps.store.set('providers.deepseek.apiKey', apiKey);
      if (deps.getLoginWindow()) deps.getLoginWindow().close();
      if (!main) deps.createMainWindow();
      else main.show();
      const win = getMain();
      if (win && !win.webContents.isDestroyed()) {
        win.webContents.on('did-finish-load', () => {
          win.webContents.send('settings:loaded', sanitizeSettings(deps.store.store));
          deps.scheduler.poll('deepseek', 'balance');
          deps.createSessionWindow();
        });
      }
    } catch (e) {
      if (deps.getLoginWindow() && !deps.getLoginWindow().isDestroyed()) {
        event.sender.send('login:error', 'API Key 验证失败: ' + e.message);
      }
    }
  });

  /* ======== Dashboard / Providers ======== */

  ipcMain.handle('get:dashboard', (event, providerId) => {
    return buildDashboardPayload(providerId);
  });

  ipcMain.handle('get:providers', () => {
    return deps.scheduler.getSnapshot();
  });

  ipcMain.handle('get:token-speed', () => {
    return deps.tokenSpeedRuntime
      ? deps.tokenSpeedRuntime.getSnapshot()
      : { enabled: false, providers: [], series: {} };
  });

  /* ======== Heatmap ======== */

  ipcMain.handle('get:heatmap', (event, arg) => {
    const { provider, year } = arg || {};
    // 全部 provider 的日数据统一来自 store 键 'usageDaily' { '<provider>:<date>': { total, cached, models? } }:
    // codex/kimi 由本地日志增量聚合;deepseek 由 fetchUsage 按月抓取时持久化(含历史回填)。
    // 显示层不套用保留窗口:已同步的历史应全部可见,清理交给 data.historyDays/prune。
    // 不传 historyDays 时 filterUsageDaily 只做畸形键过滤(无限保留)。
    const usageDaily = filterUsageDaily(deps.store.get('usageDaily') || {});
    const byProvider = {};
    const cachedByProvider = {};
    const deepseekModels = {};
    Object.keys(usageDaily).forEach((key) => {
      const idx = key.indexOf(':');
      if (idx <= 0) return;
      const pid = key.slice(0, idx);
      const date = key.slice(idx + 1);
      const total = Number(usageDaily[key] && usageDaily[key].total) || 0;
      if (total <= 0) return;
      byProvider[pid] = byProvider[pid] || {};
      byProvider[pid][date] = (byProvider[pid][date] || 0) + total;
      const cached = Number(usageDaily[key] && usageDaily[key].cached) || 0;
      if (cached > 0) {
        cachedByProvider[pid] = cachedByProvider[pid] || {};
        cachedByProvider[pid][date] = (cachedByProvider[pid][date] || 0) + cached;
      }
      // deepseek 悬停明细:当日模型分布(fetchUsage 持久化时写入)
      const models = usageDaily[key] && usageDaily[key].models;
      if (pid === 'deepseek' && Array.isArray(models) && models.length) {
        deepseekModels[date] = models.map((m) => ({ model: m.model, tokens: m.tokens }));
      }
    });
    const result = buildHeatmap(byProvider, provider || 'all', year || new Date().getFullYear());
    result.details = { byProvider: byProvider, cachedByProvider: cachedByProvider, deepseekModels: deepseekModels };
    return result;
  });

  /* ======== History Sync ======== */

  ipcMain.handle('sync:history', async (event) => {
    const sendProgress = (p) => {
      try {
        event.sender.send('sync:progress', p);
      } catch (e) { /* 设置窗口已关闭,进度丢弃 */ }
    };
    const readStore = (k) => deps.store.get(k);
    const writeStore = (k, v) => deps.store.set(k, v);
    const summary = {};

    const token = deps.store.get('providers.deepseek.sessionToken');
    if (token) {
      const storedProxy = deps.store.get('providers.proxyUrl') || null;
      const proxyUrl = storedProxy === SYSTEM_PROXY_VALUE ? resolveElectronSystemProxy : storedProxy;
      const fetcher = new UsageFetcher();
      summary.deepseek = await syncDeepSeekHistory({
        fetchMonth: (year, month) =>
          fetcher.fetchUsageAmount(token, month, year, { httpGet, proxyUrl }).then((r) => r.dailyData),
        readStore,
        writeStore,
        onProgress: sendProgress
      });
    } else {
      summary.deepseek = { skipped: true, reason: 'not-logged-in' };
    }

    for (const pid of ['codex', 'kimi']) {
      const provider = deps.registry.get(pid);
      if (!provider || typeof provider.readLocalLog !== 'function') {
        summary[pid] = { daysRebuilt: 0, earliestDate: null, skipped: true };
        continue;
      }
      summary[pid] = await rescanLocalLogs({
        providerId: pid,
        readLocalLog: () => provider.readLocalLog({ store: deps.store }, { retainAll: true }),
        readStore,
        writeStore,
        onProgress: sendProgress
      });
    }

    // 历史保留提示:最早日期落在保留窗口外时给出建议天数(只提示不擅改)
    const historyDays = deps.store.get('data.historyDays');
    const earliest = [summary.deepseek, summary.codex, summary.kimi]
      .map((r) => r && r.earliestDate)
      .filter(Boolean)
      .sort()[0] || null;
    if (earliest && Number.isInteger(historyDays) && historyDays > 0 && earliest < retentionStartDay(historyDays)) {
      const startMs = new Date(earliest + 'T12:00:00').getTime();
      summary.retentionHint = {
        historyDays,
        earliestDate: earliest,
        suggestedDays: Math.ceil((Date.now() - startMs) / 86400000) + 1
      };
    }

    if (deps.tokenSpeedRuntime && typeof deps.tokenSpeedRuntime.rebaselineAll === 'function') {
      deps.tokenSpeedRuntime.rebaselineAll();
    }

    // 广播 providers:changed,渲染端 TokenHeatmap/ProviderBar 已订阅,会自动重取 get:heatmap
    if (deps.scheduler && typeof deps.scheduler.pollAll === 'function') {
      await deps.scheduler.pollAll();
    }
    return summary;
  });

  /* ======== MCP 服务 ======== */

  ipcMain.handle('mcp:getConnectionInfo', () => {
    const rt = typeof deps.getMcpRuntime === 'function' ? deps.getMcpRuntime() : null;
    return rt ? rt.getConnectionInfo() : { enabled: false, running: false, port: null, url: null, token: null };
  });

  ipcMain.handle('mcp:rotateToken', async () => {
    const rt = typeof deps.getMcpRuntime === 'function' ? deps.getMcpRuntime() : null;
    if (!rt) throw new Error('MCP 服务未初始化');
    await rt.rotateToken();
    return rt.getConnectionInfo();
  });

  /* ======== Settings ======== */

  ipcMain.on('settings:update', (event, { key: rawKey, value }) => {
    if (!isWritableSettingKey(rawKey)) {
      console.warn('[settings] rejected non-whitelisted settings:update key:', rawKey);
      return;
    }
    const key = resolveWritableSettingKey(rawKey);
    saveSetting(deps, { key, value });
  });

  ipcMain.handle('settings:save', (event, payload) => {
    return saveSetting(deps, payload);
  });

  ipcMain.handle('settings:replace-api-key', async (event, payload) => {
    const deepseek = deps.registry.get('deepseek');
    return replaceDeepseekApiKey({
      store: deps.store,
      verifyApiKey: (apiKey) => deepseek.fetchBalance(deepseekApiKeyCtx(deps, apiKey)),
      broadcastSettings: deps.broadcastSettings
    }, payload);
  });

  ipcMain.handle('get:settings', () => {
    return sanitizeSettings(deps.store.store);
  });

  // 设置页"自定义 HTTP 代理"预填:探测本机常见代理端口是否在监听
  ipcMain.handle('detect:proxy-port', async () => {
    return { port: await detectProxyPort() };
  });

  ipcMain.on('settings:reset', () => {
    resetSettingsStore(deps.store);
    if (deps.tokenSpeedRuntime && typeof deps.tokenSpeedRuntime.applySettings === 'function') {
      deps.tokenSpeedRuntime.applySettings();
    }
    console.log('[settings] reset done (credentials and usage state preserved)');
    if (getMain()) {
      getMain().setAlwaysOnTop(true);
    }
    deps.broadcastSettings();
  });

  /* ======== Window geometry ======== */

  ipcMain.handle('get:bounds', () => {
    if (!getMain()) return null;
    return getMain().getBounds();
  });

  ipcMain.handle('window:commit', (event, bounds) => {
    if (!getMain()) return null;
    var next = deps.normalizeMainBounds(bounds);
    var current = getMain().getBounds();
    var sameSize = current.width === next.width && current.height === next.height;

    if (sameSize) {
      return deps.persistMainWindowBounds();
    }

    getMain().setBounds(next);
    return deps.persistMainWindowBounds();
  });

  ipcMain.on('window:set-bounds', (event, bounds) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== getMain() || win.isDestroyed()) return;
    var next = deps.normalizeMainBounds(bounds);
    var current = win.getBounds();
    if (current.x === next.x && current.y === next.y
        && current.width === next.width && current.height === next.height) {
      return;
    }
    win.setBounds(next, false);
  });

  ipcMain.on('window:minimize', () => {
    if (getMain()) getMain().hide();
  });

  ipcMain.on('zoom:change', (event, { delta }) => {
    if (!getMain() || getMain().isDestroyed()) return;
    var current = getMain().webContents.getZoomFactor();
    var next = Math.min(1.6, Math.max(0.7, Math.round((current + delta) * 100) / 100));
    getMain().webContents.setZoomFactor(next);
    deps.store.set('window.zoomFactor', next);
  });

  ipcMain.on('session:relogin', () => {
    deps.createSessionWindow();
  });

  ipcMain.handle('get:session-state', () => {
    const snapshot = getSessionSnapshot(deps.runtime);
    return {
      status: snapshot.status,
      loggedIn: snapshot.loggedIn,
      error: snapshot.error
    };
  });

  ipcMain.on('window:close', () => {
    if (deps.getLoginWindow()) deps.getLoginWindow().close();
  });

  ipcMain.on('login:skip', () => {
    try {
      skipDeepseekLogin({
        getLoginWindow: deps.getLoginWindow,
        getMainWindow: deps.getMainWindow,
        createMainWindow: deps.createMainWindow
      });
    } catch (error) {
      console.error('[login:skip]', JSON.stringify({
        code: error && error.code ? error.code : 'MAIN_WINDOW_UNAVAILABLE'
      }));
    }
  });

  ipcMain.on('window:close-settings', () => {
    const win = getSettings();
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.on('refresh:dashboard', async () => {
    await deps.scheduler.pollAll();
  });

  ipcMain.on('open:settings', (event) => {
    deps.createSettingsWindow();
  });

  /* ======== 缩放状态机(resize IPC 原样搬入,逻辑零改动) ======== */

  function getResizeState(win) {
    if (win === getMain()) return mainResizeState;
    if (win === getSettings()) return settingsResizeState;
    return null;
  }

  function setResizeState(win, state) {
    if (win === getMain()) {
      mainResizeState = state;
      deps.resizeState.main = !!state;
    } else if (win === getSettings()) {
      settingsResizeState = state;
      deps.resizeState.settings = !!state;
    }
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
    var isSettings = win === getSettings();
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

    if (win === getMain()) {
      deps.persistMainWindowBounds();
      deps.sendMainWindowBounds();
    }
  });
  /* ======== 贴边自动隐藏(issue #170):渲染端指针事件驱动展开/收起 ======== */

  ipcMain.on('edge-dock:pointer-enter', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== getMain()) return;
    var dock = deps.getEdgeDock && deps.getEdgeDock();
    if (dock) dock.pointerEnter();
  });

  ipcMain.on('edge-dock:pointer-leave', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== getMain()) return;
    var dock = deps.getEdgeDock && deps.getEdgeDock();
    if (dock) dock.pointerLeave();
  });
};
