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

test('heatmap reads the effective DSH usage snapshot without retention window', () => {
  assert.match(
    ipcSource,
    /const \{\s*PUSH_USAGE_KEY,\s*PUSH_COST_KEY,\s*effectiveUsageDaily\s*\} = require\('\.\/core\/dsh-usage-merge'\);/
  );
  // 显示层不传 historyDays:已同步历史全量可见,清理交给 data.historyDays/prune;
  // dsh 由 effectiveUsageDaily 合并本地 usageDaily 与 push 聚合。
  assert.match(
    ipcSource,
    /const usageDaily = effectiveUsageDaily\(deps\.store\);/
  );
});
