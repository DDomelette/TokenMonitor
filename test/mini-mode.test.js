const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMiniMode,
  MINI_WIDTH,
  MINI_HEIGHT,
  NORMAL_MIN_WIDTH,
  NORMAL_MIN_HEIGHT
} = require('../src/main/core/mini-mode');

function makeStore(initial) {
  const data = Object.assign({}, initial);
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; },
    delete: (k) => { delete data[k]; },
    _data: data
  };
}

function makeWindow(bounds) {
  return {
    bounds: Object.assign({}, bounds),
    minSize: null,
    destroyed: false,
    getBounds() { return Object.assign({}, this.bounds); },
    setBounds(b) { this.bounds = Object.assign({}, b); },
    setMinimumSize(w, h) { this.minSize = [w, h]; },
    maxSize: null,
    setMaximumSize(w, h) { this.maxSize = [w, h]; },
    resizable: true,
    setResizable(v) { this.resizable = v; },
    webContents: {
      zoom: 1,
      getZoomFactor() { return this.zoom; },
      setZoomFactor(v) { this.zoom = v; }
    },
    isDestroyed() { return this.destroyed; }
  };
}

function makeHarness(options) {
  const opts = options || {};
  const store = makeStore(opts.storeInitial || { 'window.miniMode': false, 'window.miniBounds': null });
  const win = makeWindow(opts.bounds || { x: 100, y: 100, width: 420, height: 680 });
  const calls = { applySettings: 0, broadcast: 0, persist: 0, dockDisable: 0, toggled: 0 };
  const mini = createMiniMode({
    store,
    getMainWindow: () => win,
    getEdgeDock: () => opts.edgeDock || null,
    tokenSpeedRuntime: { applySettings: () => { calls.applySettings += 1; } },
    broadcastSettings: () => { calls.broadcast += 1; },
    onToggled: () => { calls.toggled += 1; },
    persistBounds: () => {
      calls.persist += 1;
      const b = win.getBounds();
      store.set('window.x', b.x);
      store.set('window.y', b.y);
      store.set('window.width', b.width);
      store.set('window.height', b.height);
    }
  });
  return { store, win, calls, mini };
}

test('enter persists normal bounds, shrinks window, enables speed sampling', () => {
  const { store, win, calls, mini } = makeHarness();
  const result = mini.enter();
  assert.equal(result, true);
  assert.equal(mini.isActive(), true);
  // 正常 bounds 已落盘
  assert.deepEqual(
    [store.get('window.x'), store.get('window.y'), store.get('window.width'), store.get('window.height')],
    [100, 100, 420, 680]
  );
  assert.deepEqual(win.minSize, [MINI_WIDTH, MINI_HEIGHT]);
  assert.deepEqual(win.maxSize, [MINI_WIDTH, MINI_HEIGHT]);
  assert.equal(win.resizable, false);
  assert.deepEqual(win.bounds, { x: 100, y: 100, width: MINI_WIDTH, height: MINI_HEIGHT });
  assert.equal(calls.persist, 1);
  assert.equal(calls.applySettings, 1);
  assert.equal(calls.broadcast, 1);
  assert.equal(calls.toggled, 1);
});

test('exit disables edge dock when docked in mini mode', () => {
  const dock = {
    meta: { edge: 'right', expandedBounds: { x: 0, y: 0, width: 200, height: 172 } },
    disabled: false,
    getDockMeta() { return this.meta; },
    disable() { this.disabled = true; this.meta = null; }
  };
  const { mini } = makeHarness({ edgeDock: dock });
  mini.enter();
  mini.exit();
  assert.equal(dock.disabled, true);
});

test('enter uses remembered mini position but current mini size', () => {
  const { win, mini } = makeHarness({
    storeInitial: {
      'window.miniMode': false,
      'window.miniBounds': { x: 500, y: 300, width: 320, height: 228 }
    }
  });
  mini.enter();
  assert.deepEqual(win.bounds, { x: 500, y: 300, width: MINI_WIDTH, height: MINI_HEIGHT });
});

test('exit restores normal bounds and min size', async () => {
  const { store, win, mini } = makeHarness();
  mini.enter();
  // 迷你期间用户拖动了窗口
  win.setBounds({ x: 700, y: 50, width: MINI_WIDTH, height: MINI_HEIGHT });
  const result = mini.exit();
  // setBounds 在退出时推迟一拍(Windows 尺寸钳制竞态),等它落地
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(result, true);
  assert.equal(mini.isActive(), false);
  assert.deepEqual(win.minSize, [NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT]);
  assert.deepEqual(win.maxSize, [2400, 1600]);
  assert.equal(win.resizable, true);
  assert.deepEqual(win.bounds, { x: 100, y: 100, width: 420, height: 680 });
  assert.equal(store.get('window.miniMode'), false);
});

test('toggle flips state', () => {
  const { mini } = makeHarness();
  assert.equal(mini.toggle(), true);
  assert.equal(mini.toggle(), false);
});

test('enter disables edge dock when docked', () => {
  const dock = {
    meta: { edge: 'right', expandedBounds: { x: 0, y: 0, width: 420, height: 680 } },
    disabled: false,
    getDockMeta() { return this.meta; },
    disable() { this.disabled = true; this.meta = null; }
  };
  const { mini } = makeHarness({ edgeDock: dock });
  mini.enter();
  assert.equal(dock.disabled, true);
});

test('applyOnCreate only applies when persisted mini mode is on', () => {
  const off = makeHarness();
  assert.equal(off.mini.applyOnCreate(off.win), false);
  assert.equal(off.win.minSize, null);

  const on = makeHarness({
    storeInitial: {
      'window.miniMode': true,
      'window.miniBounds': { x: 10, y: 20, width: 320, height: 228 }
    }
  });
  assert.equal(on.mini.applyOnCreate(on.win), true);
  assert.deepEqual(on.win.minSize, [MINI_WIDTH, MINI_HEIGHT]);
  assert.deepEqual(on.win.bounds, { x: 10, y: 20, width: MINI_WIDTH, height: MINI_HEIGHT });
});

test('mini mode forces zoom 1 and restores it on exit', () => {
  const { win, mini } = makeHarness();
  win.webContents.setZoomFactor(0.7);
  mini.enter();
  assert.equal(win.webContents.getZoomFactor(), 1);
  mini.exit();
  assert.equal(win.webContents.getZoomFactor(), 0.7);
});

test('enter/exit are no-ops without a live window', () => {
  const store = makeStore({ 'window.miniMode': false });
  const mini = createMiniMode({ store, getMainWindow: () => null });
  assert.equal(mini.enter(), false);
  assert.equal(mini.isActive(), false);
});
