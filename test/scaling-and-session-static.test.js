const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/js/app.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
const controller = fs.readFileSync(
  path.join(root, 'src/renderer/js/layout/layout-controller.js'),
  'utf8'
);
const mainCss = fs.readFileSync(path.join(root, 'src/renderer/css/main.css'), 'utf8');
const componentsCss = fs.readFileSync(path.join(root, 'src/renderer/css/components.css'), 'utf8');

test('expired session automatically reopens the platform login window', () => {
  const handler = main.match(/async function fetchAndStoreUsage\(\) \{[\s\S]*?\n\}/);
  assert.ok(handler);
  assert.match(handler[0], /catch \(e\) \{[\s\S]*createSessionWindow\(\)/);
});

test('session expiry detection matches real unauthorized errors', () => {
  const handler = main.match(/async function fetchAndStoreUsage\(\) \{[\s\S]*?\n\}/);
  assert.ok(handler);
  assert.match(handler[0], /unauthoriz|401|403|expired/i);
  assert.doesNotMatch(handler[0], /includes\('Authorization'\)/);
});

test('expiry auto-reopen is guarded against repeated popups', () => {
  assert.match(main, /sessionReopenPending/);
});

test('ctrl wheel zoom goes through the main process zoom factor', () => {
  assert.match(app, /zoom:change/);
  assert.doesNotMatch(app, /FONT_SCALE_KEY|--ui-font-scale/);
  assert.match(preload, /zoom:change/);
  const zoomHandler = main.match(/ipcMain\.on\('zoom:change'[\s\S]*?\n  \}\);/);
  assert.ok(zoomHandler);
  assert.match(zoomHandler[0], /setZoomFactor/);
});

test('zoom factor is persisted and restored on startup', () => {
  assert.match(main, /zoomFactor/);
  const create = main.match(/function createMainWindow\(\) \{[\s\S]*?\n\}/);
  assert.ok(create);
  assert.match(create[0], /setZoomFactor/);
});

test('css no longer relies on the partial font-scale variable', () => {
  assert.doesNotMatch(mainCss, /--ui-font-scale/);
  assert.doesNotMatch(componentsCss, /--ui-font-scale/);
});

test('grid reflow is deferred while the window edge resize is active', () => {
  const resize = controller.match(/function resize\(\) \{[\s\S]*?\n  \}/);
  assert.ok(resize);
  assert.match(resize[0], /resizing/);
});
