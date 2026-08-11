const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ipc = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');

test('token speed has a dedicated invoke snapshot and event channel', () => {
  assert.match(ipc, /handle\('get:token-speed'/);
  assert.match(preload, /'get:token-speed'/);
  assert.match(preload, /'token-speed:changed'/);
});

test('main process owns one runtime and stops it before quitting', () => {
  assert.match(index, /createTokenSpeedRuntime/);
  assert.match(index, /tokenSpeedRuntime\.start\(\)/);
  assert.match(index, /tokenSpeedRuntime\.stop\(\)/);
  assert.match(index, /onUsageObservation/);
  assert.match(index, /onUsageUnavailable/);
});

test('history sync, history retention and settings reset rebaseline or disable runtime', () => {
  assert.match(ipc, /sync:history[\s\S]*?tokenSpeedRuntime\.rebaselineAll/);
  assert.match(index, /data\.historyDays[\s\S]*?rebaselineAll/);
  assert.match(ipc, /settings:reset[\s\S]*?tokenSpeedRuntime\.applySettings/);
});
