# UI Physics Engine 演进计划（Phase 4.1 — WindowState Runtime）

**日期:** 2026-06-16
**目标:** 建立 WindowState Runtime，将散落在 Renderer/Main 各处的状态变量收敛到单一数据源，根治 frameless 窗口扩张问题

## 背景

当前系统已具备 Ghost Preview、Velocity Tracking、Spring Smoothing、Deferred Commit 等物理交互能力。但 titlebar 拖动仍出现窗口扩张，诊断确认：

```
setBounds({ x: -22, y: 147, width: 407, height: 373 })
setBounds({ x: -24, y: 147, width: 407, height: 373 })
                          ↑ width/height 完全相同
调用栈: window:move handler → setBounds()
```

根因：`window:move` → `setBounds()` 即使只改 x/y 不改 width/height，frameless+transparent 窗口上也会触发 Electron non-client area re-evaluation → renderer resize → 扩张。

但更深层的问题是状态散落：

```
Renderer
  ├─ springState  (springX/springY/springW/springH)
  ├─ springTarget (targetX/targetY/targetW/targetH)
  ├─ dragTitle / dragArmed / dragReady
  ├─ resizeState / resizeGhost / resizeStartW / resizeStartH
  └─ ...

Main
  └─ BrowserWindow Bounds（唯一真相源，但不可靠）
```

这导致扩张/漂移/同步问题无法通过补丁根治。本阶段不修 bug，而是建立 WindowState Runtime 消除状态散落。

## 不做的事

- ❌ Snap / Dock / Momentum / Grid Snap
- ❌ 继续修改 dragReady / dragArmed / setBounds no-op guard
- ❌ 新增交互特性

## 架构变更

```
当前:
Mouse → Renderer变量 → setBounds() → BrowserWindow

目标:
Mouse → Intent → WindowState → Physics Runtime → Ghost → Commit → BrowserWindow
```

BrowserWindow 降级为纯输出设备，WindowState 成为唯一真相源。

---

## Step 1: 统一状态模型

新增文件：`src/renderer/js/runtime/window-state.js`

```js
const windowState = {
  // 当前状态（Physics Runtime 每帧更新）
  x: 0, y: 0, width: 0, height: 0,

  // 目标状态（Intent 写入，Physics 向目标收敛）
  targetX: 0, targetY: 0, targetWidth: 0, targetHeight: 0,

  // 速度（Velocity Solver 维护）
  vx: 0, vy: 0,

  // 交互状态机
  dragging: false,
  resizing: false,
  resizeEdge: null,

  // 约束
  minWidth: 380,
  minHeight: 200
};
```

之后所有代码不再使用散落的 `let targetX`, `let springX` 等变量，统一引用 `windowState.targetX`, `windowState.x`。

---

## Step 2: Physics Runtime

新增文件：`src/renderer/js/runtime/physics.js`

```js
const STIFFNESS = 0.18;
const DAMPING = 0.82;

function physicsTick() {
  const dx = windowState.targetX - windowState.x;
  const dy = windowState.targetY - windowState.y;

  windowState.vx += dx * STIFFNESS;
  windowState.vy += dy * STIFFNESS;

  windowState.vx *= DAMPING;
  windowState.vy *= DAMPING;

  windowState.x += windowState.vx;
  windowState.y += windowState.vy;
}
```

职责单一：从 target 向 current 做弹簧过渡，不关心鼠标/事件来源。

---

## Step 3: Runtime Loop

新增文件：`src/renderer/js/runtime/runtime.js`

```js
import { physicsTick } from './physics.js';

function loop() {
  physicsTick();
  requestAnimationFrame(loop);
}

function startRuntime() {
  loop();
}
```

`startRuntime()` 在 app 初始化时调用一次，即开启统一的 rAF 驱动的 Physics Loop。后续所有周期性逻辑（Ghost 渲染、Commit 调度）统一挂入此 Loop。

---

## Step 4: Commit Manager

新增文件：`src/renderer/js/runtime/commit-manager.js`

```js
let commitPending = false;

function scheduleCommit() {
  if (commitPending) return;
  commitPending = true;
  requestAnimationFrame(() => {
    commitPending = false;
    window.api.invoke('window:commit', {
      x: Math.round(windowState.x),
      y: Math.round(windowState.y),
      width: Math.round(windowState.width),
      height: Math.round(windowState.height)
    });
  });
}
```

### Main Process 对应

```js
ipcMain.handle('window:commit', (_, bounds) => {
  const current = mainWindow.getBounds();
  if (
    current.x === bounds.x &&
    current.y === bounds.y &&
    current.width === bounds.width &&
    current.height === bounds.height
  ) return;
  mainWindow.setBounds(bounds);
});
```

替代当前的 `window:move` / `resize:end` 两条独立的 IPC 通道，统一为一个 commit 接口。no-op guard 内置于 commit 中。

---

## Step 5: Move 与 Resize 统一为 Intent

废弃 `window:move` / `resize:start` / `resize:move` / `resize:end` 四个 IPC 通道，统一为渲染进程内部的 Intent Dispatch：

```js
function dispatchIntent(intent) {
  if (intent.type === 'move') {
    windowState.targetX = intent.x;
    windowState.targetY = intent.y;
  } else if (intent.type === 'resize') {
    windowState.targetWidth = intent.width;
    windowState.targetHeight = intent.height;
  }
}
```

### 输入适配

| 当前 IPC | 替换为 |
|----------|--------|
| `window:move` | `dispatchIntent({ type: 'move', x, y })` → 更新 targetX/Y |
| `resize:start/move` | `dispatchIntent({ type: 'resize', width, height })` → 更新 targetWidth/Height |
| `resize:end` + `window:move-end` | `scheduleCommit()` |

渲染进程不再每帧向 Main 发送 IPC，仅在 mouseup 时调用一次 commit。

---

## Step 6: Ghost 完全读取 WindowState

当前 Ghost 从 `springState` 变量渲染，改为从 `windowState` 渲染：

```js
function renderGhost() {
  ghost.style.left   = windowState.x + 'px';
  ghost.style.top    = windowState.y + 'px';
  ghost.style.width  = windowState.width + 'px';
  ghost.style.height = windowState.height + 'px';
}
```

Mouse → WindowState.target → Physics → WindowState.current → Ghost → Commit，单向数据流，无交叉依赖。

---

## Step 7: Debug Overlay

新增 Physics Debug Overlay（开发模式），显示：

```
Current:  X=123  Y=456  W=420  H=373
Target:   X=130  Y=460  W=420  H=373
Velocity: VX=2.4 VY=0.7
State:    dragging=1  resizing=0  edge=-
Commit:   pending=0  last=12ms ago
```

之后扩张再出现时，直接对比 `WindowState.width/height` 与 `BrowserWindow.getBounds()` 的值，就能确定是 WindowState 层变了还是 Electron 层单独变了，不再跨层猜测。

---

## 实施顺序

| 天 | 内容 | 新增文件 |
|----|------|----------|
| 1 | `window-state.js` → 替换散落变量 | `runtime/window-state.js` |
| 2 | `physics.js` + `runtime.js` → 统一 Runtime Loop | `runtime/physics.js`, `runtime/runtime.js` |
| 3 | Ghost 完全读取 WindowState | — |
| 4 | `commit-manager.js` + Main `window:commit` IPC | `runtime/commit-manager.js` |
| 5 | Move/Resize Intent 统一，移除旧 IPC 通道 | — |
| 6 | Debug Overlay | — |
| 7 | 重新验证扩张问题，对比 WindowState vs BrowserWindow | — |

---

## 验收标准

| 类别 | 标准 |
|------|------|
| 功能 | Move 与 Resize 使用统一 Intent + Commit 管线；所有状态读取走 WindowState |
| 性能 | `setBounds()` 仅在 mouseup 时调用一次；拖动流畅度不低于当前版本 |
| 稳定 | TitleBar 拖动无扩张；Resize 无边框闪烁；长时间拖动无状态漂移 |
| 可调试 | 扩张再出现时，Overlay 可直接定位是 WindowState 层还是 Electron 层 |
