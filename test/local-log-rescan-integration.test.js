// 集成:手动历史同步的本地日志重扫通过调度器 keyed 队列持有 provider:localLog 排他锁,
// 期间后台定时轮询同一 key 必须被合并,不能出现两个并发读者,重建总量只加一次。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Mock electron ipcMain/BrowserWindow,让 src/main/ipc.js 可被直接加载
const electronPath = require.resolve('electron');
const ipcMain = {
  _on: new Map(),
  _handle: new Map(),
  on(channel, callback) { this._on.set(channel, callback); },
  handle(channel, callback) { this._handle.set(channel, callback); },
  removeListener() {},
  removeHandler() {}
};
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { ipcMain, BrowserWindow: class {} }
};

const { startScheduler } = require('../src/main/core/scheduler');
const setupIPC = require('../src/main/ipc');

function getPath(object, key) {
  return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
}

function setPath(object, key, value) {
  const parts = key.split('.');
  let current = object;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[0]] = value;
}

function makeStore(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  return {
    data,
    get(key) { return getPath(data, key); },
    set(key, value) { setPath(data, key, value); }
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('a background local-log poll never overlaps a manual rescan holding the same key', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let activeReaders = 0;
  let maxActive = 0;
  let writes = 0;
  const provider = {
    id: 'codex',
    displayName: 'Codex',
    capabilities: { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false },
    authStatus: () => 'ok',
    async readLocalLog(ctx) {
      activeReaders += 1;
      maxActive = Math.max(maxActive, activeReaders);
      try {
        await gate;
        const usageDaily = Object.assign({}, ctx.store.get('usageDaily') || {});
        if (writes === 0) {
          usageDaily['codex:2026-06-17'] = { input: 0, cached: 0, output: 0, total: 50 };
          writes += 1;
        }
        ctx.store.set('usageDaily', usageDaily);
        return writes === 1
          ? { records: [{ provider: 'codex', ts: Date.UTC(2026, 5, 17, 12), usage: { total: 50 } }], complete: true, bytesRead: 100 }
          : { records: [], complete: true, bytesRead: 0 };
      } finally {
        activeReaders -= 1;
      }
    }
  };
  const registry = {
    list: () => [provider],
    get: (id) => (id === 'codex' ? provider : undefined)
  };
  const store = makeStore({
    usageDaily: { 'kimi:2026-06-17': { input: 0, cached: 0, output: 0, total: 5 } }
  });
  const scheduler = startScheduler({
    registry,
    store,
    broadcast() {},
    intervals: false
  });
  const deps = {
    store,
    registry,
    scheduler,
    diagnostics: { start() {}, copy() {}, openGuide() {} },
    getDiagnosticsWindow: () => null,
    createDiagnosticsWindow() {},
    getDiagnosticsTheme: () => ({}),
    getMainWindow: () => null,
    getSettingsWindow: () => null,
    getLoginWindow: () => null,
    createMainWindow() {},
    createSessionWindow() {},
    getMcpRuntime: () => null,
    buildCurvePoints: () => ({ token: [], cost: [] }),
    tokenSpeedRuntime: { rebaselineAll() {} }
  };

  try {
    setupIPC(deps);
    const handler = ipcMain._handle.get('sync:history');
    assert.ok(handler, 'sync:history handler must be registered');

    // 启动手动同步:进入 codex 重扫后 readLocalLog 阻塞,持有 codex:localLog key
    const syncPromise = handler({ sender: { send() {} } });
    await flush();
    assert.equal(activeReaders, 1, 'rescan must be the only active reader while blocked');

    // 后台定时轮询尝试同一 key:应被合并,不新增读者
    const pollPromise = scheduler.poll('codex', 'localLog');
    await flush();
    assert.equal(activeReaders, 1, 'the background poll must not start a second reader');
    assert.equal(maxActive, 1, 'provider must never have two active readers');

    release();
    await syncPromise;
    await pollPromise;

    assert.equal(maxActive, 1, 'the background poll must have coalesced onto the rescan reader');
    const usageDaily = store.get('usageDaily');
    assert.equal(usageDaily['codex:2026-06-17'].total, 50, 'rebuilt total must be added once');
    assert.equal(usageDaily['kimi:2026-06-17'].total, 5, 'other provider rows stay untouched');
  } finally {
    scheduler.stop();
  }
});
