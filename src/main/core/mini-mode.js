// 迷你模式:缩小主窗口,只显示额度圆环/余额 + Token 速度。
// 进入前先把正常 bounds 落盘(persistBounds 注入),迷你期间 persistMainWindowBounds
// 改写 window.miniBounds(见 index.js),退出时从 window.x/y/width/height 恢复。
const MINI_WIDTH = 195;
const MINI_HEIGHT = 156;
const NORMAL_MIN_WIDTH = 380;
const NORMAL_MIN_HEIGHT = 200;

function finiteInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function sanitizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = finiteInt(bounds.x);
  const y = finiteInt(bounds.y);
  const width = finiteInt(bounds.width);
  const height = finiteInt(bounds.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < MINI_WIDTH || height < MINI_HEIGHT) return null;
  return { x, y, width, height };
}

function createMiniMode(options) {
  const opts = options || {};
  const store = opts.store;
  const getMainWindow = opts.getMainWindow || (() => null);
  const getEdgeDock = opts.getEdgeDock || (() => null);
  const tokenSpeedRuntime = opts.tokenSpeedRuntime || null;
  const broadcastSettings = opts.broadcastSettings || (() => {});
  const persistBounds = opts.persistBounds || (() => {});
  const onToggled = opts.onToggled || (() => {});

  let savedZoom = null;

  // 迷你模式强制 zoom=1:用户 Ctrl+滚轮缩放会被 Chromium 按站点持久化,
  // 0.7 的缩放逐字会让 180×134 的窗口塞进 257px 视口,内容缩成一团显得"窗口太大"。
  // 退出时恢复原缩放。
  function applyMiniZoom(win) {
    try {
      const wc = win.webContents;
      if (!wc) return;
      if (savedZoom === null) savedZoom = wc.getZoomFactor();
      if (savedZoom !== 1) wc.setZoomFactor(1);
    } catch (_) { /* webContents 未就绪等,忽略 */ }
  }

  function restoreZoom(win) {
    try {
      const wc = win.webContents;
      if (wc && savedZoom !== null) wc.setZoomFactor(savedZoom);
      savedZoom = null;
    } catch (_) { /* 忽略 */ }
  }

  function isActive() {
    return !!store && store.get('window.miniMode') === true;
  }

  function liveWindow() {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win : null;
  }

  function afterChange() {
    if (tokenSpeedRuntime && typeof tokenSpeedRuntime.applySettings === 'function') {
      tokenSpeedRuntime.applySettings();
    }
    broadcastSettings();
    onToggled();
  }

  function enter() {
    const win = liveWindow();
    if (!win) return false;
    // 贴边停靠状态下直接缩窗会把隐藏坐标卷进来,先解除停靠
    const dock = getEdgeDock();
    if (dock && typeof dock.getDockMeta === 'function' && dock.getDockMeta()) {
      try { dock.disable(); } catch (_) { /* 忽略,继续进入迷你模式 */ }
    }
    // 正常模式 bounds 先落盘,退出时原样恢复
    persistBounds();
    store.set('window.miniMode', true);
    win.setMinimumSize(MINI_WIDTH, MINI_HEIGHT);
    // 窗口太小,原生缩放的边缘热区很容易被抓到:迷你模式禁用缩放,防止误拖把窗口撑大;
    // 最大尺寸一并锁定,任何路径都撑不大(始终以最小尺寸展示)
    win.setMaximumSize(MINI_WIDTH, MINI_HEIGHT);
    win.setResizable(false);
    const current = win.getBounds();
    // 位置记忆、尺寸始终取当前 MINI 规格(旧版本留下的大尺寸记忆不再沿用)
    const remembered = sanitizeBounds(store.get('window.miniBounds'));
    win.setBounds({
      x: remembered ? remembered.x : current.x,
      y: remembered ? remembered.y : current.y,
      width: MINI_WIDTH,
      height: MINI_HEIGHT
    });
    applyMiniZoom(win);
    afterChange();
    return true;
  }

  function exit() {
    const win = liveWindow();
    if (!win) return false;
    // 迷你模式也可能处于停靠收起状态:恢复正常 bounds 前先解除
    const dock = getEdgeDock();
    if (dock && typeof dock.getDockMeta === 'function' && dock.getDockMeta()) {
      try { dock.disable(); } catch (_) { /* 忽略,继续退出 */ }
    }
    store.set('window.miniMode', false);
    // 先恢复可缩放,再解除尺寸限制;Windows 上紧接着的 setBounds 若仍按旧上限
    // 钳制(约束生效与 setBounds 存在竞态),推迟一拍再恢复正常尺寸
    win.setResizable(true);
    win.setMinimumSize(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT);
    win.setMaximumSize(2400, 1600);
    const current = win.getBounds();
    const target = {
      x: finiteInt(store.get('window.x')) ?? current.x,
      y: finiteInt(store.get('window.y')) ?? current.y,
      width: finiteInt(store.get('window.width')) || NORMAL_MIN_WIDTH,
      height: finiteInt(store.get('window.height')) || NORMAL_MIN_HEIGHT
    };
    setTimeout(() => {
      const w = liveWindow();
      if (w) w.setBounds(target);
    }, 0);
    restoreZoom(win);
    afterChange();
    return true;
  }

  function toggle() {
    return isActive() ? !exit() : enter();
  }

  // 启动时迷你模式被持久化:窗口按迷你尺寸/位置创建
  function applyOnCreate(win) {
    if (!win || !isActive()) return false;
    win.setMinimumSize(MINI_WIDTH, MINI_HEIGHT);
    win.setMaximumSize(MINI_WIDTH, MINI_HEIGHT);
    win.setResizable(false);
    const remembered = sanitizeBounds(store.get('window.miniBounds'));
    const current = win.getBounds();
    win.setBounds({
      x: remembered ? remembered.x : current.x,
      y: remembered ? remembered.y : current.y,
      width: MINI_WIDTH,
      height: MINI_HEIGHT
    });
    return true;
  }

  return { isActive, toggle, enter, exit, applyOnCreate, applyMiniZoom, restoreZoom };
}

module.exports = {
  createMiniMode,
  MINI_WIDTH,
  MINI_HEIGHT,
  NORMAL_MIN_WIDTH,
  NORMAL_MIN_HEIGHT
};
