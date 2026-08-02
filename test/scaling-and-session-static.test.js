const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
const ipc = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
const scheduler = fs.readFileSync(path.join(root, 'src/main/core/scheduler.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'renderer/src/App.jsx'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(root, 'renderer/src/styles.css'), 'utf8');

test('expired session marks authStatus expired and surfaces the relogin error', () => {
  assert.match(scheduler, /setAuth\(provider\.id, 'expired'\)/);
  assert.match(main, /会话已过期，请重新登录/);
});

test('session expiry detection matches real unauthorized errors', () => {
  assert.match(scheduler, /unauthoriz|401|403|expired/i);
});

test('expiry is not auto-reopened; it drives the provider auth status', () => {
  assert.match(scheduler, /authStatus === 'expired'/);
  assert.doesNotMatch(main, /sessionReopenPending/);
});

test('ctrl wheel zoom goes through the main process zoom factor', () => {
  assert.match(app, /zoom:change/);
  assert.doesNotMatch(app, /FONT_SCALE_KEY|--ui-font-scale/);
  assert.match(preload, /zoom:change/);
  const zoomHandler = ipc.match(/ipcMain\.on\('zoom:change'[\s\S]*?\n  \}\);/);
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
  assert.doesNotMatch(stylesCss, /--ui-font-scale/);
});
