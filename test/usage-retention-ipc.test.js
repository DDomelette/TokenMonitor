const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ipcSource = fs.readFileSync(
  path.resolve(__dirname, '../src/main/ipc.js'),
  'utf8'
);

test('legacy settings:update delegates to the acknowledged settings writer', () => {
  assert.match(
    ipcSource,
    /ipcMain\.on\('settings:update',[\s\S]*?saveSetting\(deps, \{ key, value \}\);[\s\S]*?\}\);/
  );
  assert.doesNotMatch(
    ipcSource,
    /ipcMain\.on\('settings:update',[\s\S]*?deps\.store\.set\(targetKey, value\);[\s\S]*?\}\);/
  );
});

test('heatmap reads a defensively filtered usage snapshot', () => {
  assert.match(
    ipcSource,
    /const \{ filterUsageDaily \} = require\('\.\/core\/usage-retention'\);/
  );
  assert.match(
    ipcSource,
    /const usageDaily = filterUsageDaily\(\s*deps\.store\.get\('usageDaily'\) \|\| \{\},\s*deps\.store\.get\('data\.historyDays'\)\s*\);/
  );
});
