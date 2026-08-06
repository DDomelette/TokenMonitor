const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ipcSource = fs.readFileSync(path.resolve(__dirname, '../src/main/ipc.js'), 'utf8');
const preloadSource = fs.readFileSync(path.resolve(__dirname, '../src/preload/preload.js'), 'utf8');

test('sync:history handler 编排三路同步并刷新仪表盘', () => {
  assert.match(ipcSource, /ipcMain\.handle\('sync:history'/);
  assert.match(ipcSource, /require\('\.\/core\/history-sync'\)/);
  assert.match(ipcSource, /syncDeepSeekHistory\(/);
  assert.match(ipcSource, /rescanLocalLogs\(/);
  assert.match(ipcSource, /providers\.deepseek\.sessionToken/);
  assert.match(ipcSource, /sync:progress/);
  assert.match(ipcSource, /retentionHint/);
  assert.match(ipcSource, /pollAll\(\)/);
});

test('preload 白名单放行 sync:history 与 sync:progress', () => {
  assert.match(preloadSource, /'sync:history'/);
  assert.match(preloadSource, /'sync:progress'/);
});
