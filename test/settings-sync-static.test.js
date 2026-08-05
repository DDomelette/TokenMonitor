const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
const ipc = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'renderer/src/components/Dashboard.jsx'), 'utf8');

test('accepted settings updates are broadcast to live windows', () => {
  assert.match(main, /function broadcastSettings\(/);
  const updateHandler = ipc.match(/ipcMain\.on\('settings:update'[\s\S]*?\n  \}\);/);
  assert.ok(updateHandler);
  assert.match(updateHandler[0], /saveSetting\(deps,/);
});

test('React dashboard initializes layout from the same settings object via validateState', () => {
  assert.match(dashboard, /validateState\(([A-Za-z_$][\w$]*)\.layout,\s*\1\)/);
});

test('React dashboard persists layout edits back through settings:update', () => {
  assert.match(dashboard, /settings:update/);
  assert.match(dashboard, /key: 'layout'/);
});

test('React dashboard is driven by the policy registry', () => {
  assert.match(dashboard, /nearestPreset/);
  assert.match(dashboard, /GridStack\.init\(/);
});
