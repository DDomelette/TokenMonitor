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

test('ResizeHandles toggles is-window-resizing class for the whole drag', () => {
  assert.match(resizeHandles, /is-window-resizing/);
  assert.match(resizeHandles, /classList\.toggle\('is-window-resizing', active\)/);
  assert.match(resizeHandles, /setWindowResizingClass\(true\)/);
  // 松手后等原生窗口落定再恢复(scheduleRoundedRestore / maybeRestoreRounded)
  assert.match(resizeHandles, /scheduleRoundedRestore/);
  assert.match(resizeHandles, /maybeRestoreRounded/);
});

test('styles.css keeps the opaque square-cornered rules during drag resize', () => {
  const bodyRule = stylesCss.match(/html\.is-window-resizing body \{[\s\S]*?\}/);
  assert.ok(bodyRule);
  assert.match(bodyRule[0], /background:\s*#FFFFFF/);
  assert.match(bodyRule[0], /border-radius:\s*0/);
  const appRule = stylesCss.match(/html\.is-window-resizing #app \{[\s\S]*?\}/);
  assert.ok(appRule);
  assert.match(appRule[0], /border-radius:\s*0/);
  assert.match(appRule[0], /box-shadow:\s*none/);
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
