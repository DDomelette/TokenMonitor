const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'src/renderer/js/app.js'), 'utf8');
const mainCss = fs.readFileSync(path.join(root, 'src/renderer/css/main.css'), 'utf8');

test('preload exposes the window:set-bounds channel', () => {
  assert.match(preload, /'window:set-bounds'/);
});

test('main applies window:set-bounds immediately with a same-bounds guard', () => {
  const handler = main.match(/ipcMain\.on\('window:set-bounds'[\s\S]*?\n  \}\);/);
  assert.ok(handler, 'window:set-bounds handler must exist');
  assert.match(handler[0], /normalizeMainBounds/);
  assert.match(handler[0], /setBounds/);
  // must short-circuit when bounds are unchanged to avoid redundant native resizes
  assert.match(handler[0], /current\.width === next\.width/);
  // must not persist to disk on every drag frame
  assert.doesNotMatch(handler[0], /persistMainWindowBounds/);
});

test('main window drag no longer routes through the throttled resize:move path', () => {
  assert.doesNotMatch(appJs, /window\.api\.send\('resize:move'/);
});

test('drag resizes the native window immediately on every mousemove', () => {
  const mousemove = appJs.match(/document\.addEventListener\('mousemove'[\s\S]*?\n  \}\);/);
  assert.ok(mousemove);
  assert.match(mousemove[0], /requestBounds\(target\)/);
});

test('the window renders opaque and square-cornered while a drag resize is active', () => {
  // renderer toggles the class on <html> for the whole drag
  assert.match(appJs, /classList\.toggle\('is-window-resizing', active\)/);
  const onStart = appJs.match(/function onResizeStart[\s\S]*?\n  \}/);
  assert.ok(onStart);
  assert.match(onStart[0], /setWindowResizingClass\(true\)/);
  // css drops the radius, the shadow and the transparency during drag
  const rule = mainCss.match(/html\.is-window-resizing body \{[\s\S]*?\}/);
  assert.ok(rule);
  assert.match(rule[0], /background:\s*#FFFFFF/);
  assert.match(rule[0], /border-radius:\s*0/);
  const appRule = mainCss.match(/html\.is-window-resizing #app \{[\s\S]*?\}/);
  assert.ok(appRule);
  assert.match(appRule[0], /border-radius:\s*0/);
  assert.match(appRule[0], /box-shadow:\s*none/);
});

test('rounded translucent look is restored only after the native window lands on the final size', () => {
  const mouseup = appJs.match(/document\.addEventListener\('mouseup'[\s\S]*?\n  \}\);/);
  assert.ok(mouseup);
  assert.match(mouseup[0], /scheduleRoundedRestore\(_targetBounds\)/);
  // the resize listener confirms the landed size before removing the class
  assert.match(appJs, /function maybeRestoreRounded[\s\S]*?setWindowResizingClass\(false\)/);
  const resizeListener = appJs.match(/window\.addEventListener\('resize'[\s\S]*?\n    \}\);/);
  assert.ok(resizeListener);
  assert.match(resizeListener[0], /maybeRestoreRounded\(\)/);
});
