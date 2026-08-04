const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const resizeHandles = fs.readFileSync(path.join(root, 'renderer/src/components/ResizeHandles.jsx'), 'utf8');
const titleBar = fs.readFileSync(path.join(root, 'renderer/src/components/TitleBar.jsx'), 'utf8');
const stylesCss = fs.readFileSync(path.join(root, 'renderer/src/styles.css'), 'utf8');
const apiJs = fs.readFileSync(path.join(root, 'renderer/src/api.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');

test('renderer api wraps get:providers / get:dashboard / get:heatmap and providers:changed', () => {
  assert.match(apiJs, /get:providers/);
  assert.match(apiJs, /get:dashboard/);
  assert.match(apiJs, /get:heatmap/);
  assert.match(apiJs, /providers:changed/);
});

test('ResizeHandles commits window:set-bounds immediately on every mousemove', () => {
  assert.match(resizeHandles, /window:set-bounds/);
  assert.match(resizeHandles, /requestBounds\(target\)/);
  assert.match(resizeHandles, /document\.addEventListener\('mousemove'/);
});

test('ResizeHandles does not route drag resizes through the throttled resize:move path', () => {
  assert.doesNotMatch(resizeHandles, /resize:move/);
});

test('ResizeHandles has no square-corner workaround (DWM 圆角后不再需要)', () => {
  // 非透明窗口 + DWM 合成层圆角:尺寸与圆角同帧绘制,拖动期切直角的兼容逻辑已移除
  assert.doesNotMatch(resizeHandles, /is-window-resizing/);
  assert.doesNotMatch(resizeHandles, /scheduleRoundedRestore/);
  assert.doesNotMatch(resizeHandles, /maybeRestoreRounded/);
});

test('styles.css has no square-corner rules for drag resize', () => {
  assert.doesNotMatch(stylesCss, /html\.is-window-resizing/);
});

test('TitleBar wires refresh / settings / minimize buttons to their IPC channels', () => {
  assert.match(titleBar, /refresh:dashboard/);
  assert.match(titleBar, /open:settings/);
  assert.match(titleBar, /window:minimize/);
  // 8 个缩放手柄在 ResizeHandles 中渲染(EDGES 数组 + resize-${edge} 模板)
  assert.match(resizeHandles, /EDGES = \['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'\]/);
  assert.match(resizeHandles, /resize-\$\{edge\}/);
});

test('preload exposes get:heatmap for the heatmap api', () => {
  assert.match(preload, /'get:heatmap'/);
});

test('Dashboard imports every policy symbol its grid change handler uses', () => {
  const dashboard = fs.readFileSync(path.join(root, 'renderer/src/components/Dashboard.jsx'), 'utf8');
  // onChange 持久化路径依赖 validateLayout,缺失会在拖动网格时抛 ReferenceError
  assert.match(dashboard, /validateLayout\(bp,/);
  assert.match(dashboard, /import \{[\s\S]*?validateLayout[\s\S]*?\} from '\.\.\/grid\/policy\.js'/);
});
