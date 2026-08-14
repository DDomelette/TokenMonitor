const test = require('node:test');
const assert = require('node:assert/strict');

// 纯 node 环境 mock electron(与 history-sync-ipc.test.js 相同的模式),使 src/main/ipc.js 可加载。
function createFakeIpcMain() {
  const on = new Map();
  const handle = new Map();
  return {
    on(channel, callback) { on.set(channel, callback); },
    handle(channel, callback) { handle.set(channel, callback); },
    removeListener(channel, callback) { if (on.get(channel) === callback) on.delete(channel); },
    removeHandler(channel) { handle.delete(channel); },
    get handleMap() { return handle; },
    get onMap() { return on; }
  };
}

const fakeIpc = createFakeIpcMain();
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    ipcMain: fakeIpc,
    BrowserWindow: { fromWebContents: () => null }
  }
};

const setupIPC = require('../src/main/ipc');

function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
function makeFakeStore(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  return {
    get(k) { return getPath(data, k); },
    set(k, v) { setPath(data, k, v); },
    delete(k) {
      const parts = k.split('.');
      let cur = data;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (cur[parts[i]] == null) return;
        cur = cur[parts[i]];
      }
      delete cur[parts[parts.length - 1]];
    }
  };
}

// 与 src/main/index.js buildCurvePoints 等价的累计逻辑(不裁剪未来日期,便于固定断言)。
function buildCurvePoints(stats) {
  const tokenPoints = [];
  const costPoints = [];
  if (stats && stats.tokenDaily) {
    let cumToken = 0;
    stats.tokenDaily.forEach((d) => {
      cumToken += d.total;
      tokenPoints.push({ time: new Date(d.date).getTime(), totalTokens: cumToken, cumTokens: cumToken, deltaTokens: d.total, totalCost: 0, deltaCost: 0 });
    });
  }
  if (stats && stats.costDaily) {
    let cumCost = 0;
    stats.costDaily.forEach((d) => {
      cumCost += d.total;
      costPoints.push({ time: new Date(d.date).getTime(), totalCost: cumCost, cumCost: cumCost, deltaCost: d.total, totalTokens: 0, deltaTokens: 0 });
    });
  }
  return { token: tokenPoints, cost: costPoints };
}

function buildDeps(overrides) {
  return Object.assign({
    store: makeFakeStore({
      usageDaily: {
        'dsh:2026-08-12': { total: 300 },
        'dsh:2026-08-14': { total: 500 },
        'dsh:2026-08-13': { total: 200 },
        'deepseek:2026-08-13': { total: 9999 }
      },
      usageDailyCost: {
        'dsh:2026-08-12': 0.3,
        'dsh:2026-08-14': 0.5,
        'dsh:2026-08-13': 0.2,
        'deepseek:2026-08-13': 9
      }
    }),
    registry: { get: () => null, list: () => [] },
    scheduler: { getState: () => ({}), getSnapshot: () => [] },
    tokenSpeedRuntime: null,
    codexUsageRuntime: null,
    diagnostics: { start() {}, copy() {}, openGuide() {} },
    getDiagnosticsWindow: () => null,
    createDiagnosticsWindow: () => {},
    getDiagnosticsTheme: () => ({}),
    getMainWindow: () => null,
    getSettingsWindow: () => null,
    getLoginWindow: () => null,
    getEdgeDock: () => null,
    createMainWindow() {},
    createLoginWindow() {},
    createSessionWindow() {},
    createSettingsWindow() {},
    getMcpRuntime: () => null,
    runtime: {},
    resizeState: {},
    broadcastSettings() {},
    broadcastSessionState() {},
    applySetting() {},
    persistMainWindowBounds() {},
    normalizeMainBounds() {},
    sendMainWindowBounds() {},
    buildCurvePoints
  }, overrides);
}

test('get:dashboard for dsh builds dsh-prefixed token/cost dailies and a cumulative cost curve', async () => {
  setupIPC(buildDeps());
  const handler = fakeIpc.handleMap.get('get:dashboard');
  assert.ok(handler, 'get:dashboard handler registered');

  const payload = await handler(null, 'dsh');

  assert.equal(payload.providerId, 'dsh');
  assert.deepEqual(payload.stats.tokenDaily.map((d) => d.date), ['2026-08-12', '2026-08-13', '2026-08-14']);
  assert.deepEqual(payload.stats.costDaily.map((d) => d.date), ['2026-08-12', '2026-08-13', '2026-08-14']);
  assert.deepEqual(payload.stats.costDaily.map((d) => d.total), [0.3, 0.2, 0.5]);
  assert.deepEqual(payload.stats.aggregate, { token: 1000, cost: 1 });
  // 累计费用曲线:时间升序、totalCost 为逐日累计、deltaCost 为当日增量
  const times = payload.curveCost.map((p) => p.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.deepEqual(payload.curveCost.map((p) => p.deltaCost), [0.3, 0.2, 0.5]);
  assert.deepEqual(payload.curveCost.map((p) => p.totalCost), [0.3, 0.5, 1]);
  // 非 dsh 前缀不影响 dsh 输出
  assert.equal(payload.stats.tokenDaily.some((d) => d.total === 9999), false);
});

test('get:dashboard for dsh with empty store yields empty lists and empty curves', async () => {
  setupIPC(buildDeps({ store: makeFakeStore({}) }));
  const handler = fakeIpc.handleMap.get('get:dashboard');
  const payload = await handler(null, 'dsh');
  assert.deepEqual(payload.stats.tokenDaily, []);
  assert.deepEqual(payload.stats.costDaily, []);
  assert.deepEqual(payload.curveCost, []);
  assert.deepEqual(payload.curveToken, []);
});

test('get:dashboard keeps the deepseek branch unchanged (no stats without usage)', async () => {
  setupIPC(buildDeps());
  const handler = fakeIpc.handleMap.get('get:dashboard');
  const payload = await handler(null, 'deepseek');
  assert.equal(payload.providerId, 'deepseek');
  assert.equal(payload.balance, null);
  assert.equal(payload.stats, undefined);
});
