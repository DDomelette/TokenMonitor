const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('shared chart range explains insufficient retention instead of silently changing settings', () => {
  const source = fs.readFileSync(path.join(root, 'renderer/src/components/ChartRange.jsx'), 'utf8');
  assert.match(source, /getSettings\(\)\.then\(readRetention\)/);
  assert.match(source, /historyDays < days/);
  assert.match(source, /历史仅保留 \{historyDays\} 天 · 去设置扩展/);
  assert.match(source, /onClick=\{\(\) => send\('open:settings'\)\}/);
  assert.doesNotMatch(source, /saveSetting\('data\.historyDays'/);
  assert.doesNotMatch(source, /sync:history/);
});
