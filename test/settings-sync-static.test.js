const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
const ipc = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/js/app.js'), 'utf8');
const controller = fs.readFileSync(
  path.join(root, 'src/renderer/js/layout/layout-controller.js'),
  'utf8'
);
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');

test('accepted settings updates are broadcast to live windows', () => {
  assert.match(main, /function broadcastSettings\(/);
  const updateHandler = ipc.match(/ipcMain\.on\('settings:update'[\s\S]*?\n  \}\);/);
  assert.ok(updateHandler);
  assert.match(updateHandler[0], /broadcastSettings\(\)/);
});

test('component visibility is registry driven in the main renderer', () => {
  assert.match(app, /ComponentRegistry\.list\(\)/);
  assert.match(app, /AppLayout\.setComponentVisible/);
  assert.doesNotMatch(app, /components\.feeCards|components\.modelBar|components\.tokenLine|components\.costLine/);
});

test('hidden widgets leave grid geometry and can be restored', () => {
  assert.match(controller, /removeWidget\(element, false, false\)/);
  assert.match(controller, /makeWidget\(element/);
});

test('empty dashboard keeps a settings entry point', () => {
  assert.match(html, /id="dashboardEmpty"/);
  assert.match(html, /id="emptySettingsBtn"/);
});
