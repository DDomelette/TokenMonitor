const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const defsSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer/js/settings-definitions.js'), 'utf8');
const jsSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer/js/settings-window.js'), 'utf8');

test('设置页声明历史数据区块并渲染同步控件', () => {
  assert.match(defsSource, /group:\s*'历史数据'/);
  assert.match(defsSource, /type:\s*'historySync'/);
  assert.match(jsSource, /historySyncBtn/);
  assert.match(jsSource, /historySyncProgress/);
  assert.match(jsSource, /historySyncResult/);
  assert.match(jsSource, /同步历史数据/);
});

test('设置页调用 sync:history 并监听 sync:progress,展示保留天数提示', () => {
  assert.match(jsSource, /invoke\('sync:history'\)/);
  assert.match(jsSource, /on\('sync:progress'/);
  assert.match(jsSource, /retentionHint/);
  assert.match(jsSource, /data\.historyDays/);
});
