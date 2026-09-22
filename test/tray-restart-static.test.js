const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mainJs = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');

// 托盘菜单"重启":relaunch 登记重启后走 quit() 正常清理;退出项必须仍在(二者紧邻,防止误删)
test('tray menu offers restart via app.relaunch followed by graceful quit', () => {
  const menu = mainJs.match(/function updateTrayMenu\(\)[\s\S]*?tray\.setContextMenu/);
  assert.ok(menu, 'updateTrayMenu must exist');
  const restart = menu[0].match(/\{\s*label: '重启'[\s\S]*?\}/);
  assert.ok(restart, 'tray menu must contain a 重启 item');
  assert.match(restart[0], /app\.relaunch\(\)/);
  assert.match(restart[0], /app\.quit\(\)/);
  assert.match(menu[0], /label: '退出'/);
});
