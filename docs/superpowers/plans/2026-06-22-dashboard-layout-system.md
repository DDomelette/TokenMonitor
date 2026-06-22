# Dashboard Layout System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved editable dashboard grid with preset component sizing, animated collision reflow, compact/wide persistence, registry-driven visibility, and no native window regressions.

**Architecture:** GridStack owns dashboard geometry and collision behavior. Small UMD modules provide a testable component registry, preset policy, migration/validation, and a renderer-side layout controller; the main process remains the persistence and broadcast boundary. Native BrowserWindow movement and resizing stay frozen and share no state with dashboard geometry.

**Tech Stack:** Electron 40, vanilla JavaScript, GridStack 12.3.3, ECharts 5.5, electron-store 8, Node built-in test runner.

---

## File Map

**Create:**

- `src/renderer/js/layout/component-registry.js` - component metadata and runtime lifecycle registry.
- `src/renderer/js/layout/layout-policy.js` - breakpoints, presets, defaults, validation, and migration.
- `src/renderer/js/layout/reflow-animator.js` - transform-based neighbor movement animation.
- `src/renderer/js/layout/layout-controller.js` - GridStack lifecycle, edit mode, persistence, and visibility.
- `src/renderer/css/layout.css` - grid item geometry, edit affordances, snap feedback, and animation states.
- `test/window-runtime-static.test.js` - frozen window boundary and debug-overlay regression checks.
- `test/component-registry.test.js` - registry contract tests.
- `test/layout-policy.test.js` - breakpoint, preset, validation, and migration tests.
- `test/dashboard-markup.test.js` - GridStack structure and script-order checks.

**Modify:**

- `package.json` - test command and GridStack dependency.
- `package-lock.json` - dependency lock.
- `src/main/store.js` - nullable versioned layout default.
- `src/main/index.js` - broadcast settings updates and accept complete layout snapshots.
- `src/preload/preload.js` - keep existing settings channel contract; no new broad IPC surface.
- `src/renderer/index.html` - GridStack assets, layout button, widget markup, and debug removal.
- `src/renderer/settings-window.html` - load component registry before settings definitions.
- `src/renderer/js/settings-definitions.js` - generate component toggles from the registry.
- `src/renderer/js/settings-window.js` - preserve generated controls and current debounce behavior.
- `src/renderer/js/app.js` - initialize layout controller and registry-driven visibility.
- `src/renderer/js/components/fee-cards.js` - render into the widget content host.
- `src/renderer/js/components/curve-chart.js` - expose frame-coalesced resize lifecycle.
- `src/renderer/js/components/model-bar.js` - expose frame-coalesced resize lifecycle.
- `src/renderer/css/main.css` - move component surface styling off the GridStack positioning node.
- `src/renderer/css/components.css` - preset-responsive component internals.

## Task 1: Freeze Window Boundaries and Remove the Production Debug Overlay

**Files:**

- Create: `test/window-runtime-static.test.js`
- Modify: `package.json`
- Modify: `src/renderer/index.html`

- [ ] **Step 1: Add a failing production-boundary test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('production dashboard does not load the debug overlay', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  assert.doesNotMatch(html, /debug-overlay\.js/);
});

test('dashboard layout code never controls BrowserWindow geometry', () => {
  const layoutDir = path.join(root, 'src/renderer/js/layout');
  if (!fs.existsSync(layoutDir)) return;
  const source = fs.readdirSync(layoutDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(layoutDir, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /setBounds|setSize|setPosition|window:commit/);
});
```

- [ ] **Step 2: Add the test command**

Update `package.json`:

```json
"scripts": {
  "start": "electron .",
  "test": "node --test",
  "build:win": "electron-builder --win",
  "build:mac": "electron-builder --mac"
}
```

- [ ] **Step 3: Run the test and confirm the expected failure**

Run: `npm test`

Expected: FAIL because `src/renderer/index.html` still loads `js/runtime/debug-overlay.js`.

- [ ] **Step 4: Remove only the production script load**

Delete this line from `src/renderer/index.html`:

```html
<script src="js/runtime/debug-overlay.js"></script>
```

Keep the source file for the deferred Debug-mode redesign.

- [ ] **Step 5: Run the focused test**

Run: `node --test test/window-runtime-static.test.js`

Expected: 2 tests pass.

## Task 2: Add the Component Registry Contract

**Files:**

- Create: `src/renderer/js/layout/component-registry.js`
- Create: `test/component-registry.test.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/settings-window.html`
- Modify: `src/renderer/js/settings-definitions.js`

- [ ] **Step 1: Write registry contract tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/renderer/js/layout/component-registry');

test('component ids and settings keys are unique', () => {
  const items = registry.list();
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert.equal(new Set(items.map((item) => item.settingsKey)).size, items.length);
});

test('every component defines compact and wide presets', () => {
  registry.list().forEach((item) => {
    assert.ok(item.presets.compact.length > 0, item.id);
    assert.ok(item.presets.wide.length > 0, item.id);
    assert.ok(item.defaultPlacement.compact.preset, item.id);
    assert.ok(item.defaultPlacement.wide.preset, item.id);
  });
});

test('unknown components are rejected', () => {
  assert.equal(registry.get('missing-component'), null);
});
```

- [ ] **Step 2: Run the test and confirm the expected failure**

Run: `node --test test/component-registry.test.js`

Expected: FAIL with `MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the UMD registry**

Create a registry that exports to CommonJS tests and `window.ComponentRegistry` in Electron:

```js
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ComponentRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var components = [
    {
      id: 'fee-cards',
      label: '费用概览卡片',
      settingsKey: 'components.feeCards',
      defaultVisible: true,
      presets: {
        compact: [{ name: 'standard', w: 4, h: 4 }, { name: 'expanded', w: 4, h: 5 }],
        wide: [{ name: 'half', w: 6, h: 4 }, { name: 'full', w: 12, h: 4 }]
      },
      defaultPlacement: {
        compact: { x: 0, y: 0, w: 4, h: 4, preset: 'standard' },
        wide: { x: 0, y: 0, w: 6, h: 4, preset: 'half' }
      }
    },
    {
      id: 'model-bar',
      label: '每日 Token 消耗',
      settingsKey: 'components.modelBar',
      defaultVisible: true,
      presets: {
        compact: [{ name: 'standard', w: 4, h: 8 }, { name: 'tall', w: 4, h: 10 }],
        wide: [{ name: 'half', w: 6, h: 8 }, { name: 'full', w: 12, h: 8 }, { name: 'tall', w: 12, h: 10 }]
      },
      defaultPlacement: {
        compact: { x: 0, y: 4, w: 4, h: 8, preset: 'standard' },
        wide: { x: 6, y: 0, w: 6, h: 8, preset: 'half' }
      }
    },
    {
      id: 'token-line',
      label: 'Token 消耗趋势',
      settingsKey: 'components.tokenLine',
      defaultVisible: true,
      presets: {
        compact: [{ name: 'standard', w: 4, h: 7 }, { name: 'tall', w: 4, h: 9 }],
        wide: [{ name: 'half', w: 6, h: 7 }, { name: 'full', w: 12, h: 7 }, { name: 'tall', w: 12, h: 9 }]
      },
      defaultPlacement: {
        compact: { x: 0, y: 12, w: 4, h: 7, preset: 'standard' },
        wide: { x: 0, y: 4, w: 6, h: 7, preset: 'half' }
      }
    },
    {
      id: 'cost-line',
      label: '费用增长趋势',
      settingsKey: 'components.costLine',
      defaultVisible: true,
      presets: {
        compact: [{ name: 'standard', w: 4, h: 7 }, { name: 'tall', w: 4, h: 9 }],
        wide: [{ name: 'half', w: 6, h: 7 }, { name: 'full', w: 12, h: 7 }, { name: 'tall', w: 12, h: 9 }]
      },
      defaultPlacement: {
        compact: { x: 0, y: 19, w: 4, h: 7, preset: 'standard' },
        wide: { x: 0, y: 11, w: 12, h: 7, preset: 'full' }
      }
    }
  ];
  var runtime = Object.create(null);

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function list() { return clone(components); }
  function get(id) {
    var item = components.find(function (candidate) { return candidate.id === id; });
    return item ? clone(item) : null;
  }
  function registerRuntime(id, hooks) {
    if (!get(id)) throw new Error('Unknown component: ' + id);
    runtime[id] = hooks || {};
  }
  function getRuntime(id) { return runtime[id] || null; }

  return { list: list, get: get, registerRuntime: registerRuntime, getRuntime: getRuntime };
});
```

- [ ] **Step 4: Load the registry in both renderer windows**

Load `js/layout/component-registry.js` before `settings-definitions.js` in `index.html` and `settings-window.html`.

- [ ] **Step 5: Generate component toggles from the registry**

Replace `settings-definitions.js` with:

```js
window.App = window.App || {};

var windowDefinitions = [
  { group: '窗口', key: 'window.opacity', type: 'slider', label: '透明度', min: 20, max: 100, default: 92, unit: '%' },
  { group: '窗口', key: 'window.alwaysOnTop', type: 'toggle', label: '始终置顶', default: true },
  { group: '窗口', key: 'window.autoLaunch', type: 'toggle', label: '开机自启', default: false },
  { group: '窗口', key: 'window.followSystemTheme', type: 'toggle', label: '跟随系统主题', default: true },
  { group: '窗口', key: 'window.darkMode', type: 'select', label: '主题模式', options: [
    { value: 'system', label: '跟随系统' },
    { value: 'dark', label: '夜间模式' },
    { value: 'light', label: '日间模式' }
  ], default: 'system' },
  { group: '窗口', key: 'window.layoutLocked', type: 'toggle', label: '锁定布局', default: true }
];

var componentDefinitions = window.ComponentRegistry.list().map(function (component) {
  return {
    group: '组件',
    key: component.settingsKey,
    type: 'toggle',
    label: component.label,
    default: component.defaultVisible
  };
});

var tailDefinitions = [
  { group: '数据', key: 'data.historyDays', type: 'select', label: '历史数据保留', options: [
    { value: 3, label: '3 天' },
    { value: 7, label: '7 天' },
    { value: 30, label: '30 天' }
  ], default: 7 },
  { group: '关于', key: 'apiKey', type: 'password', label: 'API Key', default: '' }
];

window.SettingsDefinitions = windowDefinitions.concat(componentDefinitions, tailDefinitions);
```

- [ ] **Step 6: Run registry tests**

Run: `node --test test/component-registry.test.js`

Expected: 3 tests pass.

## Task 3: Implement Layout Policy, Defaults, Validation, and Migration

**Files:**

- Create: `src/renderer/js/layout/layout-policy.js`
- Create: `test/layout-policy.test.js`
- Modify: `src/main/store.js`

- [ ] **Step 1: Write policy tests**

Cover these exact cases:

```js
test('639 is compact and 640 is wide', () => {
  assert.equal(policy.breakpointForWidth(639), 'compact');
  assert.equal(policy.breakpointForWidth(640), 'wide');
});

test('nearest preset returns full for a nearly full model bar', () => {
  assert.equal(policy.nearestPreset('model-bar', 'wide', 11.6, 8).name, 'full');
});

test('migration preserves compact component order', () => {
  const migrated = policy.migrate({ componentOrder: ['cost-line', 'fee-cards', 'model-bar', 'token-line'] });
  assert.deepEqual(migrated.compact.items.map((item) => item.id), ['cost-line', 'fee-cards', 'model-bar', 'token-line']);
});

test('validation removes unknown and duplicate ids', () => {
  const result = policy.validateLayout('compact', {
    columns: 4,
    items: [
      { id: 'fee-cards', x: 0, y: 0, w: 4, h: 4, preset: 'standard' },
      { id: 'fee-cards', x: 0, y: 4, w: 4, h: 4, preset: 'standard' },
      { id: 'missing', x: 0, y: 8, w: 4, h: 4, preset: 'standard' }
    ]
  });
  assert.equal(result.items.length, 1);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/layout-policy.test.js`

Expected: FAIL with `MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `layout-policy.js` as a UMD module**

Required public API:

```js
return {
  VERSION: 1,
  BREAKPOINT_WIDTH: 640,
  breakpointForWidth: breakpointForWidth,
  columnsForBreakpoint: columnsForBreakpoint,
  defaultLayout: defaultLayout,
  nearestPreset: nearestPreset,
  migrate: migrate,
  validateLayout: validateLayout,
  validateState: validateState
};
```

Implementation rules:

- `breakpointForWidth(width)` returns `compact` below 640, otherwise `wide`.
- `nearestPreset()` minimizes squared `(w - preset.w)` and `(h - preset.h)` distance.
- Compact migration walks `componentOrder`, uses each compact default width/height, and accumulates `y` by item height.
- Wide migration uses registry defaults.
- Validation rounds finite values, clamps `x + w` to the breakpoint column count, rejects duplicates/unknown IDs, and replaces invalid presets with the nearest legal preset.
- `validateState()` returns defaults for only the malformed breakpoint.

- [ ] **Step 4: Add a nullable layout default**

Add to `src/main/store.js` defaults:

```js
layout: null,
```

Keep `componentOrder` for one-way migration compatibility.

- [ ] **Step 5: Run policy and full tests**

Run: `npm test`

Expected: all tests pass.

## Task 4: Install GridStack and Convert Dashboard Markup

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/js/components/fee-cards.js`
- Modify: `src/renderer/css/main.css`
- Create: `src/renderer/css/layout.css`
- Create: `test/dashboard-markup.test.js`

- [ ] **Step 1: Write failing markup tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../src/renderer/js/layout/component-registry');

const html = fs.readFileSync(path.resolve(__dirname, '../src/renderer/index.html'), 'utf8');

test('dashboard loads local GridStack assets', () => {
  assert.match(html, /node_modules\/gridstack\/dist\/gridstack\.min\.css/);
  assert.match(html, /node_modules\/gridstack\/dist\/gridstack-all\.js/);
});

test('each registered component is a grid item with a content surface', () => {
  registry.list().forEach((component) => {
    assert.match(html, new RegExp('data-component-id="' + component.id + '"'));
  });
  assert.equal((html.match(/grid-stack-item-content/g) || []).length, registry.list().length);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test test/dashboard-markup.test.js`

Expected: FAIL because GridStack assets and markup are absent.

- [ ] **Step 3: Install the pinned dependency**

Run: `npm install gridstack@12.3.3 --save`

Expected: `gridstack` appears in dependencies and the lockfile updates without audit errors that block installation.

- [ ] **Step 4: Load local GridStack assets**

Add to `index.html`:

```html
<link rel="stylesheet" href="../../node_modules/gridstack/dist/gridstack.min.css">
<link rel="stylesheet" href="css/layout.css">
...
<script src="../../node_modules/gridstack/dist/gridstack-all.js"></script>
```

Load `layout.css` after `main.css`/`components.css` and GridStack JavaScript before `layout-controller.js`.

- [ ] **Step 5: Convert component wrappers without changing chart IDs**

The content root becomes:

```html
<div class="content grid-stack" id="dashboardGrid">
```

Each item follows this structure:

```html
<section class="component-wrapper grid-stack-item" data-component-id="model-bar" gs-id="model-bar">
  <div class="grid-stack-item-content component-surface">
    <div class="component-title">每日 Token 消耗</div>
    <div class="chart-container" id="daily-chart"></div>
  </div>
</section>
```

The fee widget includes `<div id="fee-cards-content"></div>` inside its content surface. Update `fee-cards.js` to render into `fee-cards-content`.

- [ ] **Step 6: Move surface styling off positioning nodes**

`layout.css` must define:

```css
.grid-stack { min-height: 100%; }
.grid-stack-item { min-width: 0; }
.grid-stack-item-content { overflow: hidden; }
.component-surface {
  inset: 0;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 12px;
}
```

Remove background, border, padding, and radius from `.component-wrapper` in `main.css`; keep only non-visual positioning-safe properties.

- [ ] **Step 7: Run markup and full tests**

Run: `npm test`

Expected: all tests pass.

## Task 5: Implement the Layout Controller and Edit Mode

**Files:**

- Create: `src/renderer/js/layout/layout-controller.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/js/app.js`
- Modify: `src/renderer/css/layout.css`

- [ ] **Step 1: Add the title-bar edit control**

Add an icon button next to Settings:

```html
<button class="titlebar-btn" id="layoutEditBtn" title="编辑布局" aria-label="编辑布局" aria-pressed="false">
  <span aria-hidden="true">▦</span>
</button>
```

Locked mode remains the default.

- [ ] **Step 2: Implement the controller public contract**

`layout-controller.js` exposes:

```js
window.AppLayout = {
  init: init,
  setEditing: setEditing,
  isEditing: isEditing,
  setComponentVisible: setComponentVisible,
  applySettings: applySettings,
  resize: resize,
  destroy: destroy
};
```

`init()` must:

1. Validate or migrate settings layout.
2. Select compact/wide from the current BrowserWindow width.
3. Initialize GridStack with `column`, `cellHeight: 24`, `margin: 10`, `animate: true`, `float: false`, title-based dragging, and edge/corner resizing.
4. Load only visible registered widgets.
5. Apply `grid.setStatic(settings.window.layoutLocked !== false)`.
6. Bind `dragstart`, `drag`, `dragstop`, `resizestart`, `resize`, `resizestop`, and `change`.

Use these options:

```js
{
  column: policy.columnsForBreakpoint(activeBreakpoint),
  cellHeight: 24,
  margin: 10,
  animate: true,
  float: false,
  draggable: { handle: '.component-title' },
  resizable: { handles: 'e,se,s,sw,w' }
}
```

- [ ] **Step 3: Implement legal preset commit**

During `resize`, update a `.layout-snap-label` and schedule chart resize once per animation frame. During `resizestop`:

```js
var preset = policy.nearestPreset(id, activeBreakpoint, node.w, node.h);
grid.update(element, { w: preset.w, h: preset.h });
element.dataset.layoutPreset = preset.name;
saveActiveLayout();
```

- [ ] **Step 4: Implement independent breakpoint switching**

On window resize, if the breakpoint changes:

1. Snapshot the current breakpoint in memory.
2. Switch GridStack column count.
3. Load the target breakpoint layout.
4. Preserve the source layout unchanged.
5. Resize all visible charts after the new layout settles.

Debounce breakpoint switching to one animation frame, not a timer.

- [ ] **Step 5: Wire edit mode**

Clicking `layoutEditBtn` toggles `setEditing()`:

- `grid.setStatic(!editing)`.
- Toggle `.layout-editing` on `#app`.
- Update title and `aria-pressed`.
- On exit, persist the complete legal active layout and send `window.layoutLocked=true`.
- On entry, send `window.layoutLocked=false`.

- [ ] **Step 6: Replace old drag-sort initialization**

Remove `window.App.initDragSort('.content')` from `app.js` and remove the `drag-sort.js` script load from `index.html`. Do not delete the old file until the new layout system is verified.

- [ ] **Step 7: Run syntax and unit tests**

Run:

```powershell
Get-ChildItem -Recurse -Filter *.js src,test | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
npm test
```

Expected: syntax exit 0 and all tests pass.

## Task 6: Add Animated Reflow and Frame-Coalesced Chart Resize

**Files:**

- Create: `src/renderer/js/layout/reflow-animator.js`
- Modify: `src/renderer/js/layout/layout-controller.js`
- Modify: `src/renderer/js/app.js`
- Modify: `src/renderer/js/components/curve-chart.js`
- Modify: `src/renderer/js/components/model-bar.js`
- Modify: `src/renderer/css/layout.css`

- [ ] **Step 1: Implement the reflow animator**

Public API:

```js
window.ReflowAnimator = {
  capture: capture,
  play: play,
  clear: clear
};
```

`capture(container, activeElement)` records `getBoundingClientRect()` for every non-active `.grid-stack-item`. `play()` calculates old-to-new deltas, applies inverse `translate3d()`, then removes transforms on the next animation frame with a 180 ms transition.

- [ ] **Step 2: Integrate animation around GridStack changes**

- Capture before a drag/resize-driven layout change.
- Play after GridStack updates neighbor positions.
- Exclude `.ui-draggable-dragging` and `.ui-resizable-resizing`.
- Clear transforms on drag-stop, resize-stop, breakpoint switch, and controller destroy.

- [ ] **Step 3: Centralize chart resize scheduling**

Add one renderer scheduler:

```js
var chartResizeFrame = null;
function scheduleChartResize() {
  if (chartResizeFrame !== null) return;
  chartResizeFrame = requestAnimationFrame(function () {
    chartResizeFrame = null;
    window.ComponentRegistry.list().forEach(function (component) {
      var runtime = window.ComponentRegistry.getRuntime(component.id);
      if (runtime && runtime.resize) runtime.resize();
    });
  });
}
```

Register the daily, Token, and cost chart resize hooks in their component modules. Fee cards register no-op resize behavior.

- [ ] **Step 4: Add edit affordance and animation CSS**

Required states:

```css
.layout-grid-lines,
.layout-resize-handle,
.layout-snap-label { opacity: 0; pointer-events: none; }
.layout-editing .layout-grid-lines,
.layout-editing .grid-stack-item:hover .layout-resize-handle,
.layout-editing .grid-stack-item.is-selected .layout-resize-handle { opacity: 1; }
.layout-reflowing { transition: transform 180ms var(--ease-standard); }
.ui-draggable-dragging,
.ui-resizable-resizing { transition: none !important; }
```

- [ ] **Step 5: Run syntax and tests**

Run the Task 5 syntax command and `npm test`.

Expected: all checks pass.

## Task 7: Make Visibility and Layout Persistence Live and Registry-Driven

**Files:**

- Modify: `src/main/index.js`
- Modify: `src/renderer/js/app.js`
- Modify: `src/renderer/js/settings-window.js`
- Modify: `src/renderer/js/layout/layout-controller.js`
- Modify: `test/layout-policy.test.js`

- [ ] **Step 1: Add hidden-component restoration tests**

Test that validating a state retains layout records regardless of visibility and that re-enabling an item returns its saved placement before auto-placement.

- [ ] **Step 2: Broadcast settings after every accepted update**

After `store.set(key, value)` and `applySetting(key, value)` in the main process:

```js
function broadcastSettings() {
  [mainWindow, settingsWindow].forEach(function (win) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('settings:loaded', store.store);
    }
  });
}
```

Call `broadcastSettings()` after updates and reset. Do not add a new IPC channel.

- [ ] **Step 3: Replace one-way visibility logic**

Replace the four `if (... === false) classList.add('hidden')` branches in `app.js` with:

```js
window.ComponentRegistry.list().forEach(function (component) {
  var visible = getPath(settings, component.settingsKey) !== false;
  window.AppLayout.setComponentVisible(component.id, visible);
});
```

The controller removes hidden items from active GridStack geometry while preserving their saved compact and wide records. Re-enabling first restores the saved node, then uses nearest-free auto placement if occupied.

- [ ] **Step 4: Persist complete breakpoint snapshots**

On drag-stop, resize-stop, and finish-edit, send only:

```js
window.api.send('settings:update', {
  key: 'layout.' + activeBreakpoint,
  value: { columns: columns, items: items }
});
```

Write `layout.version=1` once after migration. Do not send settings writes from `drag`, `resize`, or `change` pointer-frequency events.

- [ ] **Step 5: Add the empty dashboard state**

When all registered components are hidden, show an unframed neutral message and Settings icon button. Hide it immediately when any component becomes visible.

- [ ] **Step 6: Run full tests**

Run: `npm test`

Expected: all tests pass, including visibility restoration.

## Task 8: Verification and Window Regression Gate

**Files:**

- Modify tests only if verification exposes a missing invariant.

- [ ] **Step 1: Run all automated checks fresh**

```powershell
Get-ChildItem -Recurse -Filter *.js src,test | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
npm test
```

Expected: syntax exit 0 and zero test failures.

- [ ] **Step 2: Audit forbidden production paths**

Run:

```powershell
rg -n "debug-overlay\.js|initDragSort|window:commit|setPosition\(" src/renderer src/main
```

Expected:

- No production load of `debug-overlay.js`.
- No call to `initDragSort`.
- No dashboard layout call to `window:commit` or `setPosition`.
- Legacy files may contain definitions only if they are not loaded.

- [ ] **Step 3: Start the application**

Run: `npm start`

Expected: Electron opens without renderer or main-process errors.

- [ ] **Step 4: Verify component interactions manually**

At 380, 639, 640, and 720 px widths:

- Enter and exit edit mode.
- Drag every component across every other component.
- Confirm 180 ms neighbor reflow with no overlap.
- Resize each component to every allowed preset.
- Confirm the outer box follows the pointer continuously.
- Confirm charts resize continuously and tooltips remain available when locked.
- Hide and restore every component from Settings.
- Hide all components and verify the empty state.
- Restart and verify compact and wide layouts restore independently.

- [ ] **Step 5: Run the native-window regression matrix**

- Move the main window repeatedly and confirm no width/height growth.
- Resize all eight main-window edges/corners and confirm no jump on release.
- Move, then resize, and confirm the window does not jump to the screen origin.
- Verify the top edge remains selectable.
- Repeat drag and resize checks for Settings.
- Confirm the known non-accumulating 1 px DIP monitor noise is not persisted.

- [ ] **Step 6: Review the final diff**

Run:

```powershell
git diff --check
git status --short
git diff -- src/main/index.js src/main/store.js src/preload/preload.js src/renderer package.json package-lock.json test
```

Expected: no whitespace errors, no unrelated file reversion, and only intended layout-system changes in reviewed files.

## Follow-Up Plan

After this plan passes the regression gate, create and execute a separate B2 visual-token plan covering shared tokens, main-window refinement, Settings/Login stylesheet extraction, light/dark QA, and screenshot baselines. Do not mix that work into layout-engine debugging.
