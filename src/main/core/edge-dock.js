// 贴边自动隐藏(Edge Auto Hide)核心:几何 + 状态机,纯逻辑无 Electron 依赖。
// 主进程注入定时器/时钟与 onApplyBounds/onPersistDock 回调即可驱动;
// 设计约束见 issue #170:隐藏坐标只存内存,持久化的永远是展开可见 bounds。

const EDGE_SNAP_THRESHOLD = 12;
const REVEAL_STRIP_SIZE = 12;
const COLLAPSE_DELAY = 500;
const EXPAND_DURATION = 160;
const COLLAPSE_DURATION = 260;
const FRAME_MS = 16;
// 可停靠边:只吸附左右和上。下边缘吸附实测体验差(任务栏侧难以拖离),不接。
// 角落平局时的稳定优先级:先左右后上
const EDGE_PRIORITY = ['left', 'right', 'top'];

function edgeDistances(bounds, wa) {
  return {
    left: bounds.x - wa.x,
    right: wa.x + wa.width - (bounds.x + bounds.width),
    top: bounds.y - wa.y,
    bottom: wa.y + wa.height - (bounds.y + bounds.height)
  };
}

// 距某边 <= threshold 视为贴边;多候选取距离最近,平局按 EDGE_PRIORITY
function nearestEdge(bounds, wa, threshold) {
  if (!wa) return null;
  const d = edgeDistances(bounds, wa);
  let best = null;
  EDGE_PRIORITY.forEach((edge) => {
    if (best === null || d[edge] < d[best]) best = edge;
  });
  return d[best] <= threshold ? best : null;
}

// 展开态对齐:窗口与停靠边齐平(尺寸不变,坐标取整防 DPI 漂移)
function snapToEdge(bounds, edge, wa) {
  const snapped = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  };
  if (edge === 'left') snapped.x = wa.x;
  if (edge === 'right') snapped.x = wa.x + wa.width - snapped.width;
  if (edge === 'top') snapped.y = wa.y;
  if (edge === 'bottom') snapped.y = wa.y + wa.height - snapped.height;
  return snapped;
}

// 收起态:窗口大部分移出 workArea,只留 strip 像素触发条(仍在工作区内)
function collapsedBounds(expanded, edge, stripSize) {
  const strip = stripSize || REVEAL_STRIP_SIZE;
  const c = { ...expanded };
  if (edge === 'left') c.x = expanded.x - (expanded.width - strip);
  if (edge === 'right') c.x = expanded.x + (expanded.width - strip);
  if (edge === 'top') c.y = expanded.y - (expanded.height - strip);
  if (edge === 'bottom') c.y = expanded.y + (expanded.height - strip);
  return c;
}

// 显示器拔掉/拓扑变化后的救援:把窗口完整移回 workArea 内
function clampToWorkArea(bounds, wa) {
  const width = Math.min(Math.round(bounds.width), wa.width);
  const height = Math.min(Math.round(bounds.height), wa.height);
  return {
    x: Math.min(Math.max(Math.round(bounds.x), wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(Math.round(bounds.y), wa.y), wa.y + wa.height - height),
    width,
    height
  };
}

function intersectionArea(a, b) {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return w * h;
}

// 以实际相交面积选所属 display 的 workArea;完全不相交时回退到第一个 display
function pickWorkArea(bounds, displays) {
  const list = (displays || []).filter((d) => d && d.workArea);
  if (!list.length) return null;
  let best = list[0].workArea;
  let bestArea = -1;
  list.forEach((d) => {
    const area = intersectionArea(bounds, d.workArea);
    if (area > bestArea) {
      bestArea = area;
      best = d.workArea;
    }
  });
  return best;
}

// 展开缓动:阻尼感(起步快、末端急减速落定,easeOutQuint)
function easeDamped(t) {
  return 1 - Math.pow(1 - t, 5);
}

// 收起缓动:缓起步后加速离场(easeInCubic)。首帧位移小,肉眼能看到窗口开始滑走,
// 不会像阻尼缓动那样首帧就跳掉大半、观感像闪现
function easeAccelerate(t) {
  return t * t * t;
}

function lerpBounds(from, to, t) {
  return {
    x: Math.round(from.x + (to.x - from.x) * t),
    y: Math.round(from.y + (to.y - from.y) * t),
    width: Math.round(from.width + (to.width - from.width) * t),
    height: Math.round(from.height + (to.height - from.height) * t)
  };
}

function pointInRect(p, r) {
  return !!p && !!r
    && p.x >= r.x && p.x < r.x + r.width
    && p.y >= r.y && p.y < r.y + r.height;
}

// 状态机:undocked / expanded-docked / collapsing / collapsed / expanding。
// 任何动画状态都可被反向事件打断(从当前坐标反向,不排队、不跳变)。
function createEdgeDock(options) {
  const opts = options || {};
  const threshold = opts.snapThreshold || EDGE_SNAP_THRESHOLD;
  const strip = opts.stripSize || REVEAL_STRIP_SIZE;
  const collapseDelay = opts.collapseDelay || COLLAPSE_DELAY;
  const expandDuration = opts.expandDuration || EXPAND_DURATION;
  const collapseDuration = opts.collapseDuration || COLLAPSE_DURATION;
  const frameMs = opts.frameMs || FRAME_MS;
  const setTimeoutImpl = opts.setTimeout || setTimeout;
  const clearTimeoutImpl = opts.clearTimeout || clearTimeout;
  const now = opts.now || (() => Date.now());
  const onApplyBounds = opts.onApplyBounds || (() => {});
  const onPersistDock = opts.onPersistDock || (() => {});
  const onStateChange = opts.onStateChange || (() => {});
  // 可选:查询真实光标屏幕坐标(主进程注入 screen.getCursorScreenPoint),
  // 收起前做最终裁决,见 scheduleCollapse
  const getCursorPoint = opts.getCursorPoint || null;

  let state = 'undocked';
  let suspended = false;
  let pointerInside = false;
  let edge = null;
  let expandedBounds = null;
  let currentBounds = null;
  // 上一帧坐标:Windows 的 move 事件可能滞后一帧到达(getBounds 返回的是
  // 事件对应的旧位置),回声判定要同时容忍当前帧与上一帧
  let prevBounds = null;
  let collapseTimer = null;
  let anim = null;

  function setState(next) {
    if (state === next) return;
    state = next;
    onStateChange(state);
  }

  function cancelCollapseTimer() {
    if (collapseTimer !== null) {
      clearTimeoutImpl(collapseTimer);
      collapseTimer = null;
    }
  }

  function cancelAnimation() {
    if (anim !== null) {
      if (anim.timer !== null) clearTimeoutImpl(anim.timer);
      anim = null;
    }
  }

  // 取整并归一化 -0(Math.round 可能产出 -0,与 0 的深比较不相等)
  function round0(v) {
    const r = Math.round(v);
    return r === 0 ? 0 : r;
  }

  function sameBounds(a, b) {
    return !!a && !!b
      && Math.round(a.x) === b.x && Math.round(a.y) === b.y
      && Math.round(a.width) === b.width && Math.round(a.height) === b.height;
  }

  function apply(bounds) {
    const next = {
      x: round0(bounds.x),
      y: round0(bounds.y),
      width: round0(bounds.width),
      height: round0(bounds.height)
    };
    // 与当前坐标一致则不下发:setBounds 会再触发 move 事件,避免回声循环
    if (sameBounds(next, currentBounds)) return;
    prevBounds = currentBounds;
    currentBounds = next;
    onApplyBounds(currentBounds);
  }

  // 动画主循环:基于单调时间计算进度,可取消/反向,末帧精确落目标。
  // 注意:apply() 触发的回调(move 事件等非回声路径)可能同步取消动画,
  // tick 内每次操作前都要重新确认自己还是当前动画
  function startAnimation(target, duration, stateAfter, ease) {
    cancelAnimation();
    const easeFn = ease || easeDamped;
    const from = currentBounds ? { ...currentBounds } : { ...target };
    const start = now();
    const self = { target: { ...target }, timer: null };
    anim = self;
    const tick = () => {
      if (anim !== self) return;
      const t = duration <= 0 ? 1 : Math.min(1, (now() - start) / duration);
      if (t >= 1) {
        anim = null;
        apply(target);
        setState(stateAfter);
        return;
      }
      apply(lerpBounds(from, target, easeFn(t)));
      if (anim !== self) return; // apply 的回调里被取消:不再排下一帧
      self.timer = setTimeoutImpl(tick, frameMs);
    };
    self.timer = setTimeoutImpl(tick, frameMs);
  }

  function scheduleCollapse() {
    cancelCollapseTimer();
    if (suspended || pointerInside) return;
    collapseTimer = setTimeoutImpl(() => {
      collapseTimer = null;
      if (suspended || pointerInside) return;
      if (state !== 'expanded-docked' && state !== 'expanding') return;
      // 最终裁决:光标实际还在窗口区域内就不收起,重新等待。
      // 边界场景下 enter/leave 事件会丢失/乱序(窗口在光标下滑动时系统
      // 合成事件不可靠),纯事件驱动会形成"收起→触发条滑到光标下→
      // mouseenter→展开→mouseleave→再收起"的自激振荡(窗口抽搐)
      if (getCursorPoint && pointInRect(getCursorPoint(), expandedBounds)) {
        scheduleCollapse();
        return;
      }
      setState('collapsing');
      startAnimation(collapsedBounds(expandedBounds, edge, strip), collapseDuration, 'collapsed', easeAccelerate);
    }, collapseDelay);
  }

  return {
    // 用户开始拖动(非回声 move 事件):立即取消停靠与进行中的动画。
    // 拖动用 -webkit-app-region:drag,主进程拿不到 drag-end;若等 debounce 再处理,
    // 收起态窗口会在拖动中途被重新吸附/收起,从鼠标下抽走(吸住拖不走/闪烁的根因)
    userMoveStarted() {
      if (state === 'undocked') return;
      cancelCollapseTimer();
      cancelAnimation();
      onPersistDock(null);
      edge = null;
      expandedBounds = null;
      setState('undocked');
    },

    // 用户拖动停止(debounce 后):贴边则停靠,离边则取消停靠
    userMoveSettled(bounds, displays) {
      cancelCollapseTimer();
      cancelAnimation();
      currentBounds = { ...bounds };
      const wa = pickWorkArea(bounds, displays);
      const e = nearestEdge(bounds, wa, threshold);
      if (e) {
        edge = e;
        expandedBounds = snapToEdge(bounds, e, wa);
        apply(expandedBounds);
        onPersistDock({ edge, expandedBounds: { ...expandedBounds } });
        setState('expanded-docked');
        scheduleCollapse();
      } else {
        if (state !== 'undocked') onPersistDock(null);
        edge = null;
        expandedBounds = null;
        setState('undocked');
      }
    },

    pointerEnter() {
      pointerInside = true;
      cancelCollapseTimer();
      if (state === 'collapsed' || state === 'collapsing') {
        setState('expanding');
        startAnimation(expandedBounds, expandDuration, 'expanded-docked');
      }
    },

    pointerLeave() {
      pointerInside = false;
      if (state === 'expanded-docked' || state === 'expanding') scheduleCollapse();
    },

    // 托盘显示/second-instance/打开设置等主动唤醒:强制完整展开
    reveal() {
      cancelCollapseTimer();
      if (state === 'collapsed' || state === 'collapsing') {
        setState('expanding');
        startAnimation(expandedBounds, expandDuration, 'expanded-docked');
      }
    },

    // resize、设置窗口打开等场景暂停自动收起;恢复时按指针位置重新评估
    setSuspended(next) {
      suspended = !!next;
      if (suspended) {
        cancelCollapseTimer();
      } else if (state === 'expanded-docked' && !pointerInside) {
        scheduleCollapse();
      }
    },

    // 关闭 edgeAutoHide:即使已收起也先完整恢复,再清停靠状态
    disable() {
      cancelCollapseTimer();
      cancelAnimation();
      if (state !== 'undocked' && expandedBounds) apply(expandedBounds);
      if (state !== 'undocked') onPersistDock(null);
      edge = null;
      expandedBounds = null;
      setState('undocked');
    },

    // resize 结束:更新展开尺寸并保持停靠边;若已收起按新尺寸重算露出条
    resizeSettled(bounds, displays) {
      currentBounds = { ...bounds };
      if (state === 'undocked' || !edge) return;
      const wa = pickWorkArea(bounds, displays);
      expandedBounds = snapToEdge(bounds, edge, wa);
      onPersistDock({ edge, expandedBounds: { ...expandedBounds } });
      apply(state === 'collapsed' ? collapsedBounds(expandedBounds, edge, strip) : expandedBounds);
    },

    // 重启恢复逻辑停靠:重新匹配当前显示器,落不进现存 workArea 的先修正
    restoreDock(meta, displays) {
      if (!meta || !meta.edge || !meta.expandedBounds) return false;
      // 旧版本可能持久化了已不接的边(如 bottom),按不支持处理
      if (EDGE_PRIORITY.indexOf(meta.edge) === -1) return false;
      const wa = pickWorkArea(meta.expandedBounds, displays);
      if (!wa) return false;
      edge = meta.edge;
      expandedBounds = snapToEdge(clampToWorkArea(meta.expandedBounds, wa), edge, wa);
      apply(expandedBounds);
      setState('expanded-docked');
      scheduleCollapse();
      return true;
    },

    getState: () => state,
    // 程序性动画进行中:主进程据此抑制 move 持久化与高频 bounds 广播
    isProgrammatic: () => anim !== null,
    // move 事件回声识别:bounds 与机器最后下发(或上一帧)的坐标一致时,说明是 setBounds 的回声。
    // Windows 的 move 事件可能滞后一帧,getBounds 返回旧位置,两帧都要容忍
    matchesCurrent: (bounds) => sameBounds(bounds, currentBounds) || sameBounds(bounds, prevBounds),
    getDockMeta: () => (edge && expandedBounds
      ? { edge, expandedBounds: { ...expandedBounds } }
      : null)
  };
}

module.exports = {
  EDGE_SNAP_THRESHOLD,
  REVEAL_STRIP_SIZE,
  COLLAPSE_DELAY,
  EXPAND_DURATION,
  COLLAPSE_DURATION,
  nearestEdge,
  snapToEdge,
  collapsedBounds,
  clampToWorkArea,
  intersectionArea,
  pickWorkArea,
  pointInRect,
  easeDamped,
  easeAccelerate,
  lerpBounds,
  createEdgeDock
};
