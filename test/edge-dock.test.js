const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EDGE_SNAP_THRESHOLD,
  REVEAL_STRIP_SIZE,
  nearestEdge,
  snapToEdge,
  collapsedBounds,
  clampToWorkArea,
  pickWorkArea,
  easeDamped,
  lerpBounds,
  createEdgeDock
} = require('../src/main/core/edge-dock');

const WA = { x: 0, y: 0, width: 1920, height: 1040 }; // 主屏 workArea(底部 40px 任务栏)
const WIN = { width: 420, height: 680 };

/* ======== 几何 ======== */

test('nearestEdge picks the closest workArea edge within threshold', () => {
  assert.equal(nearestEdge({ x: 5, y: 200, ...WIN }, WA, 12), 'left');
  assert.equal(nearestEdge({ x: 1920 - 420 - 8, y: 200, ...WIN }, WA, 12), 'right');
  assert.equal(nearestEdge({ x: 400, y: 3, ...WIN }, WA, 12), 'top');
  // 下边缘不接:贴底也不停靠(任务栏侧吸附实测难以拖离)
  assert.equal(nearestEdge({ x: 400, y: 1040 - 680 - 2, ...WIN }, WA, 12), null);
  assert.equal(nearestEdge({ x: 500, y: 300, ...WIN }, WA, 12), null);
});

test('corner window docks to a single nearest edge (stable tie-break)', () => {
  // 右下角:右距 2,下距 2 → bottom 不是候选,取右边
  const corner = { x: 1920 - 420 - 2, y: 1040 - 680 - 2, ...WIN };
  assert.equal(nearestEdge(corner, WA, 12), 'right');
  // 右距 2,下距 9 → 最近的候选边是右边
  assert.equal(nearestEdge({ x: 1920 - 422, y: 1040 - 689, ...WIN }, WA, 12), 'right');
  // 右距 9,下距 2 → bottom 不是候选,右距 9 ≤ 阈值仍取右边
  assert.equal(nearestEdge({ x: 1920 - 429, y: 1040 - 682, ...WIN }, WA, 12), 'right');
  // 只贴底(其余边都超阈值)→ 不停靠
  assert.equal(nearestEdge({ x: 500, y: 1040 - 682, ...WIN }, WA, 12), null);
});

test('collapsedBounds keeps only the reveal strip inside the workArea', () => {
  const expanded = { x: 0, y: 100, ...WIN };
  const collapsed = collapsedBounds(expanded, 'left', 12);
  assert.equal(collapsed.x + collapsed.width, WA.x + 12); // 只露 12px
  assert.equal(collapsed.y, expanded.y);
  assert.equal(collapsed.width, expanded.width);

  const right = collapsedBounds({ x: 1920 - 420, y: 100, ...WIN }, 'right', 12);
  assert.equal(right.x, WA.x + WA.width - 12);

  const top = collapsedBounds({ x: 300, y: 0, ...WIN }, 'top', 12);
  assert.equal(top.y + top.height, WA.y + 12);

  const bottom = collapsedBounds({ x: 300, y: 1040 - 680, ...WIN }, 'bottom', 12);
  assert.equal(bottom.y, WA.y + WA.height - 12);
});

test('snapToEdge aligns the expanded window flush with the dock edge', () => {
  assert.deepEqual(snapToEdge({ x: 5, y: 200, ...WIN }, 'left', WA), { x: 0, y: 200, ...WIN });
  assert.deepEqual(snapToEdge({ x: 1490, y: 200, ...WIN }, 'right', WA), { x: 1500, y: 200, ...WIN });
  assert.deepEqual(snapToEdge({ x: 300, y: 3, ...WIN }, 'top', WA), { x: 300, y: 0, ...WIN });
  assert.deepEqual(snapToEdge({ x: 300, y: 350, ...WIN }, 'bottom', WA), { x: 300, y: 360, ...WIN });
});

test('negative-coordinate secondary display works', () => {
  const waLeft = { x: -1080, y: -200, width: 1080, height: 1880 }; // 主屏左上的副屏
  const b = { x: -1075, y: 300, ...WIN };
  assert.equal(nearestEdge(b, waLeft, 12), 'left');
  const snapped = snapToEdge(b, 'left', waLeft);
  assert.equal(snapped.x, -1080);
  const collapsed = collapsedBounds(snapped, 'left', 12);
  assert.equal(collapsed.x + collapsed.width, -1080 + 12);
});

test('pickWorkArea selects the display with max intersection, DPI scaling stays integral', () => {
  const displays = [
    { id: 1, workArea: WA },
    { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 720 } }
  ];
  // 窗口横跨两屏,主屏相交更多(主屏侧 220px,副屏侧 200px 且高度更矮)
  const straddle = { x: 1700, y: 100, ...WIN };
  assert.deepEqual(pickWorkArea(straddle, displays), WA);
  const onSecond = { x: 2200, y: 100, ...WIN };
  assert.deepEqual(pickWorkArea(onSecond, displays), displays[1].workArea);
  // 1.5x DPI 逻辑像素:吸附/收起结果必须为整数,不产生累计漂移
  const wa15 = { x: 0, y: 0, width: 1280, height: 693 };
  const snapped = snapToEdge({ x: 3.6, y: 100.4, width: 280, height: 453.5 }, 'left', wa15);
  assert.ok(Number.isInteger(snapped.x) && Number.isInteger(snapped.y));
  const collapsed = collapsedBounds(snapped, 'left', 12);
  assert.ok(Number.isInteger(collapsed.x) && Number.isInteger(collapsed.width));
});

test('clampToWorkArea rescues bounds that fell off a removed display', () => {
  const clamped = clampToWorkArea({ x: 3000, y: 900, ...WIN }, WA);
  assert.ok(clamped.x + clamped.width <= WA.x + WA.width);
  assert.ok(clamped.y + clamped.height <= WA.y + WA.height);
  assert.ok(clamped.x >= WA.x && clamped.y >= WA.y);
});

test('easeDamped endpoints, damping shape and lerpBounds rounding', () => {
  assert.equal(easeDamped(0), 0);
  assert.equal(easeDamped(1), 1);
  // 阻尼感:起步快(easeOutQuint 前 20% 走完约 67%),末端减速落定
  assert.ok(easeDamped(0.2) > 0.6);
  assert.ok(easeDamped(0.8) < 1 && easeDamped(0.8) > 0.9);
  const mid = lerpBounds({ x: 0, y: 0, width: 100, height: 100 }, { x: 100, y: 50, width: 100, height: 100 }, 0.5);
  assert.deepEqual(mid, { x: 50, y: 25, width: 100, height: 100 });
});

/* ======== 状态机(注入定时器/时钟) ======== */

function makeHarness() {
  const timers = new Map();
  let nextId = 1;
  let nowMs = 1000;
  const applied = [];
  const persisted = [];
  const states = [];
  const dock = createEdgeDock({
    now: () => nowMs,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: nowMs + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    onApplyBounds: (b) => applied.push(b),
    onPersistDock: (m) => persisted.push(m),
    onStateChange: (s) => states.push(s)
  });
  return {
    dock, applied, persisted, states,
    advance(ms) {
      const end = nowMs + ms;
      // 循环触发:动画帧在触发中会排下一帧,必须按到期时间逐帧推进
      for (;;) {
        let fired = false;
        for (const [id, t] of [...timers.entries()]) {
          if (t.at <= end && timers.has(id)) {
            timers.delete(id);
            nowMs = Math.max(nowMs, t.at);
            t.fn();
            fired = true;
          }
        }
        if (!fired) break;
      }
      nowMs = end;
    }
  };
}

test('undocked → docked → collapse → hover → expand → leave → collapse', () => {
  const h = makeHarness();
  const nearLeft = { x: 4, y: 200, ...WIN };
  h.dock.userMoveSettled(nearLeft, [{ id: 1, workArea: WA }]);
  assert.equal(h.dock.getState(), 'expanded-docked');
  // 持久化的是展开对齐后的可见 bounds,不是贴边前的原始坐标
  assert.deepEqual(h.persisted.at(-1), { edge: 'left', expandedBounds: { x: 0, y: 200, ...WIN } });

  h.dock.pointerLeave();
  h.advance(499);
  assert.equal(h.dock.getState(), 'expanded-docked'); // delay 未到不收起
  h.advance(1);
  assert.equal(h.dock.getState(), 'collapsing');
  h.advance(300); // COLLAPSE_DURATION 260 + 帧间隔
  assert.equal(h.dock.getState(), 'collapsed');
  const finalCollapsed = h.applied.at(-1);
  assert.equal(finalCollapsed.x + finalCollapsed.width, WA.x + REVEAL_STRIP_SIZE);

  h.dock.pointerEnter();
  assert.equal(h.dock.getState(), 'expanding');
  h.advance(300);
  assert.equal(h.dock.getState(), 'expanded-docked');
  assert.deepEqual(h.applied.at(-1), { x: 0, y: 200, ...WIN });

  h.dock.pointerLeave();
  h.advance(500 + 300);
  assert.equal(h.dock.getState(), 'collapsed');
});

test('collapse animation reverses immediately on hover (no queue, no jump)', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  h.dock.pointerLeave();
  h.advance(500); // 触发收起
  h.advance(100); // 收起动画进行中
  assert.equal(h.dock.getState(), 'collapsing');
  h.dock.pointerEnter(); // 立即反向
  assert.equal(h.dock.getState(), 'expanding');
  h.advance(300);
  assert.equal(h.dock.getState(), 'expanded-docked');
  assert.deepEqual(h.applied.at(-1), { x: 0, y: 200, ...WIN });
});

test('expand animation reverses on leave after the collapse delay', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  h.dock.pointerLeave();
  h.advance(500 + 300); // 完全收起
  h.dock.pointerEnter();
  h.advance(50); // 展开动画进行中
  h.dock.pointerLeave(); // 不立即反向,等 delay
  h.advance(499);
  assert.notEqual(h.dock.getState(), 'collapsing');
  h.advance(1);
  assert.equal(h.dock.getState(), 'collapsing');
});

test('rapid enter/leave does not corrupt final state', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  for (let i = 0; i < 5; i++) {
    h.dock.pointerLeave();
    h.advance(120);
    h.dock.pointerEnter();
    h.advance(80);
  }
  h.advance(500);
  assert.equal(h.dock.getState(), 'expanded-docked');
  h.dock.pointerLeave();
  h.advance(500 + 300);
  assert.equal(h.dock.getState(), 'collapsed');
  assert.deepEqual(h.applied.at(-1), collapsedBounds({ x: 0, y: 200, ...WIN }, 'left', REVEAL_STRIP_SIZE));
});

test('suspend blocks collapse; resume re-evaluates', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  h.dock.setSuspended(true);
  h.dock.pointerLeave();
  h.advance(2000);
  assert.equal(h.dock.getState(), 'expanded-docked'); // 挂起期间不收起
  h.dock.setSuspended(false);
  h.advance(500 + 300);
  assert.equal(h.dock.getState(), 'collapsed');
});

test('user drag away from the edge undocks and clears persisted dock', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  assert.equal(h.dock.getState(), 'expanded-docked');
  h.dock.pointerEnter(); // 保持展开
  h.dock.userMoveSettled({ x: 500, y: 300, ...WIN }, [{ id: 1, workArea: WA }]);
  assert.equal(h.dock.getState(), 'undocked');
  assert.equal(h.persisted.at(-1), null);
  // 离开后不再自动收起
  h.dock.pointerLeave();
  h.advance(2000);
  assert.equal(h.dock.getState(), 'undocked');
});

test('userMoveStarted immediately undocks so the window is never yanked mid-drag', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  assert.equal(h.dock.getState(), 'expanded-docked');
  // 用户抓住已停靠窗口拖动:第一个非回声 move 就解除停靠
  h.dock.userMoveStarted();
  assert.equal(h.dock.getState(), 'undocked');
  assert.equal(h.persisted.at(-1), null);
  // 之后即使停在原边缘附近,也要等 userMoveSettled 才重新停靠
  h.advance(2000);
  assert.equal(h.dock.getState(), 'undocked');
});

test('userMoveStarted cancels a running collapse animation mid-frame (no flicker)', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  h.dock.pointerLeave();
  h.advance(500 + 100); // 收起动画进行中
  assert.equal(h.dock.getState(), 'collapsing');
  const framesBefore = h.applied.length;
  h.dock.userMoveStarted(); // 用户在动画途中抓住窗口
  assert.equal(h.dock.getState(), 'undocked');
  assert.equal(h.dock.isProgrammatic(), false);
  h.advance(1000); // 动画已取消,不再产生新帧
  assert.equal(h.applied.length, framesBefore);
});

test('userMoveStarted frees a collapsed window grabbed by its reveal strip', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  h.dock.pointerLeave();
  h.advance(500 + 300);
  assert.equal(h.dock.getState(), 'collapsed');
  h.dock.userMoveStarted();
  assert.equal(h.dock.getState(), 'undocked');
  assert.equal(h.persisted.at(-1), null);
});

test('restoreDock rejects edges that are no longer dockable (legacy bottom meta)', () => {
  const h = makeHarness();
  const ok = h.dock.restoreDock(
    { edge: 'bottom', expandedBounds: { x: 300, y: 1040 - 680, ...WIN } },
    [{ id: 1, workArea: WA }]
  );
  assert.equal(ok, false);
  assert.equal(h.dock.getState(), 'undocked');
});

test('animation cancelled synchronously inside onApplyBounds does not crash (move-echo race)', () => {
  // 复现主进程崩溃:动画 tick → apply → onApplyBounds(setBounds)同步触发
  // move 事件 → 非回声判定 → userMoveStarted → cancelAnimation 把 anim 置空,
  // 回到 tick 继续写 anim.timer → TypeError。修复后应安静取消
  const timers = new Map();
  let nextId = 1;
  let nowMs = 1000;
  let dock = null;
  const applied = [];
  dock = createEdgeDock({
    now: () => nowMs,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: nowMs + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    onApplyBounds: (b) => {
      applied.push(b);
      // 第二帧起模拟 Windows 滞后 move 事件触发的拖动打断
      if (applied.length >= 2 && dock) dock.userMoveStarted();
    }
  });
  const advance = (ms) => {
    const end = nowMs + ms;
    for (;;) {
      let fired = false;
      for (const [id, t] of [...timers.entries()]) {
        if (t.at <= end && timers.has(id)) { timers.delete(id); nowMs = Math.max(nowMs, t.at); t.fn(); fired = true; }
      }
      if (!fired) break;
    }
    nowMs = end;
  };
  dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  dock.pointerLeave();
  assert.doesNotThrow(() => advance(500 + 300));
  assert.equal(dock.getState(), 'undocked');
  assert.equal(dock.isProgrammatic(), false);
});

test('matchesCurrent tolerates the previous animation frame (lagging move events)', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  h.dock.pointerLeave();
  h.advance(500 + 64); // 收起动画走了几帧
  const frames = h.applied.slice(1); // 第一帧是吸附落定
  assert.ok(frames.length >= 2);
  // 当前帧与上一帧都算回声
  assert.equal(h.dock.matchesCurrent(frames.at(-1)), true);
  assert.equal(h.dock.matchesCurrent(frames.at(-2)), true);
  // 更早的帧/任意位置不算
  assert.equal(h.dock.matchesCurrent({ x: 500, y: 300, ...WIN }), false);
});

test('collapse eases in slowly (no flash), expand starts fast with damping', () => {
  // 收起:前 ~15% 时长位移应很小(缓起步,肉眼可见窗口开始滑走)
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  h.dock.pointerLeave();
  h.advance(500 + 32); // 260ms 收起的前 32ms
  const collapseFrame = h.applied.at(-1);
  const collapsedX = 0 - (420 - REVEAL_STRIP_SIZE);
  const collapseTravel = Math.abs(collapseFrame.x - 0) / Math.abs(collapsedX - 0);
  assert.ok(collapseTravel < 0.05, `collapse early travel ${collapseTravel} should be < 5%`);

  // 展开:前 25% 时长位移应过半(阻尼感,快速弹出后减速落定)
  h.advance(300);
  h.dock.pointerEnter();
  const fromX = h.applied.at(-1).x;
  h.advance(40); // 160ms 展开的前 40ms
  const expandFrame = h.applied.at(-1);
  const expandTravel = Math.abs(expandFrame.x - fromX) / Math.abs(0 - fromX);
  assert.ok(expandTravel > 0.5, `expand early travel ${expandTravel} should be > 50%`);
});

test('reveal fully expands a collapsed window (tray / second-instance)', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  h.dock.pointerLeave();
  h.advance(500 + 300);
  assert.equal(h.dock.getState(), 'collapsed');
  h.dock.reveal();
  assert.equal(h.dock.getState(), 'expanding');
  h.advance(300);
  assert.equal(h.dock.getState(), 'expanded-docked');
  assert.deepEqual(h.applied.at(-1), { x: 0, y: 200, ...WIN });
});

test('disable() while collapsed restores the full window and clears dock state', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  h.dock.pointerLeave();
  h.advance(500 + 300);
  assert.equal(h.dock.getState(), 'collapsed');
  h.dock.disable();
  assert.equal(h.dock.getState(), 'undocked');
  assert.deepEqual(h.applied.at(-1), { x: 0, y: 200, ...WIN });
  assert.equal(h.persisted.at(-1), null);
});

test('restoreDock remaps to current displays and never restores off-screen coordinates', () => {
  const h = makeHarness();
  const ok = h.dock.restoreDock(
    { edge: 'left', expandedBounds: { x: 0, y: 200, ...WIN } },
    [{ id: 1, workArea: WA }]
  );
  assert.equal(ok, true);
  assert.equal(h.dock.getState(), 'expanded-docked');
  assert.deepEqual(h.applied.at(-1), { x: 0, y: 200, ...WIN });

  // 副屏已拔:expandedBounds 落在不存在的屏幕上 → 修正到现存 workArea 内
  const h2 = makeHarness();
  h2.dock.restoreDock(
    { edge: 'right', expandedBounds: { x: 3420, y: 100, ...WIN } },
    [{ id: 1, workArea: WA }]
  );
  const applied = h2.applied.at(-1);
  assert.ok(applied.x + applied.width <= WA.x + WA.width);
  assert.ok(applied.x >= WA.x);
});

test('isProgrammatic marks animation frames so move persistence can be suppressed', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  assert.equal(h.dock.isProgrammatic(), false); // 吸附是单帧落定
  h.dock.pointerLeave();
  h.advance(500);
  assert.equal(h.dock.isProgrammatic(), true); // 收起动画中
  h.advance(300);
  assert.equal(h.dock.isProgrammatic(), false);
});

test('resizeSettled updates expanded bounds while keeping the dock edge', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 1498, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  assert.equal(h.dock.getState(), 'expanded-docked');
  // 用户向右缘 resize 变宽 40px,停靠右缘不变
  const resized = { x: 1500, y: 200, width: 460, height: 680 };
  h.dock.resizeSettled(resized, [{ id: 1, workArea: WA }]);
  assert.deepEqual(h.persisted.at(-1), {
    edge: 'right',
    expandedBounds: { x: 1920 - 460, y: 200, width: 460, height: 680 }
  });
  assert.deepEqual(h.applied.at(-1), { x: 1460, y: 200, width: 460, height: 680 });
});

test('constants match the issue MVP tuning', () => {
  assert.ok(EDGE_SNAP_THRESHOLD >= 10 && EDGE_SNAP_THRESHOLD <= 16);
  assert.ok(REVEAL_STRIP_SIZE >= 10 && REVEAL_STRIP_SIZE <= 16);
});

/* ======== 接线断言:主进程/preload/渲染端必须接入状态机 ======== */

const fs = require('fs');
const path = require('path');

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

test('main process wires edge dock: runtime, move handler, persistence guard, wake paths', () => {
  const index = readSrc('src/main/index.js');
  assert.match(index, /require\('\.\/core\/edge-dock'\)/);
  assert.match(index, /createEdgeDock\(/);
  // move 回声识别 + 拖拽停止后评估停靠 + 拖动开始立即解除停靠
  assert.match(index, /edgeDock\.matchesCurrent/);
  assert.match(index, /edgeDock\.userMoveSettled/);
  assert.match(index, /edgeDock\.userMoveStarted\(\)/);
  // 动画进行中的 move 事件一律忽略(滞后帧事件靠坐标猜回声会误判成拖动→来回抖动)
  assert.match(index, /edgeDock\.isProgrammatic\(\)\) return;/);
  // 动画帧不广播、不落盘
  assert.match(index, /edgeDock\.isProgrammatic\(\)/);
  // 停靠中持久化展开可见 bounds
  assert.match(index, /edgeDock\.getDockMeta\(\)/);
  // 重启恢复逻辑停靠
  assert.match(index, /edgeDock\.restoreDock/);
  // 托盘/第二实例唤醒强制展开
  assert.match(index, /revealMainWindow/);
  assert.match(index, /edgeDock\.reveal\(\)/);
  // 设置窗口打开时挂起自动收起
  assert.match(index, /edgeDock\.setSuspended\(true\)/);
  // 关闭开关安全展开
  assert.match(index, /case 'window\.edgeAutoHide'/);
  assert.match(index, /edgeDock\.disable\(\)/);
});

test('ipc registers pointer enter/leave channels for the main window only', () => {
  const ipc = readSrc('src/main/ipc.js');
  assert.match(ipc, /ipcMain\.on\('edge-dock:pointer-enter'/);
  assert.match(ipc, /ipcMain\.on\('edge-dock:pointer-leave'/);
  assert.match(ipc, /deps\.getEdgeDock/);
});

test('preload whitelists pointer channels; settings expose the toggle; store has defaults', () => {
  const preload = readSrc('src/preload/preload.js');
  assert.match(preload, /'edge-dock:pointer-enter'/);
  assert.match(preload, /'edge-dock:pointer-leave'/);
  const definitions = readSrc('src/renderer/js/settings-definitions.js');
  assert.match(definitions, /key: 'window\.edgeAutoHide'/);
  const storeSrc = readSrc('src/main/store.js');
  assert.match(storeSrc, /edgeAutoHide: false/);
  assert.match(storeSrc, /edgeDock: null/);
});

test('renderer reports pointer enter/leave on the window body', () => {
  const entry = readSrc('renderer/src/main.jsx');
  assert.match(entry, /mouseenter/);
  assert.match(entry, /mouseleave/);
  assert.match(entry, /edge-dock:pointer-enter/);
  assert.match(entry, /edge-dock:pointer-leave/);
});

test('apply echo is suppressed: identical bounds never re-emitted (move-event loop guard)', () => {
  const h = makeHarness();
  h.dock.userMoveSettled({ x: 4, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  const appliedAfterDock = h.applied.length;
  // 主进程 setBounds 后收到的 move 回声:getBounds 与机器下发坐标一致
  assert.equal(h.dock.matchesCurrent({ x: 0, y: 200, ...WIN }), true);
  assert.equal(h.dock.matchesCurrent({ x: 3, y: 200, ...WIN }), false);
  // 回声位置重新评估不应再下发任何 setBounds
  h.dock.userMoveSettled({ x: 0, y: 200, ...WIN }, [{ id: 1, workArea: WA }]);
  assert.equal(h.applied.length, appliedAfterDock);
  // 收起完成后,最终帧的 move 回声同样可识别(坐标在屏外,绝不能拿去再评估停靠)
  h.dock.pointerLeave();
  h.advance(500 + 300);
  const collapsed = h.applied.at(-1);
  assert.equal(h.dock.matchesCurrent(collapsed), true);
});
