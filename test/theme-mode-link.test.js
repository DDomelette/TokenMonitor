const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// resolveTheme(renderer/src/theme-sync.js)中 followSystemTheme 是主开关:
// 它为 true 时完全忽略 window.darkMode 的手动值。设置窗口的"主题模式"下拉
// 必须与"跟随系统主题"开关联动,否则手动选择会被系统主题覆盖,界面看似切不回来。
test('selecting an explicit dark/light mode turns off follow-system-theme', () => {
  const link = require('../src/renderer/js/theme-mode-link.js');

  assert.deepEqual(link.linkedWrites('window.darkMode', 'dark'), [
    { key: 'window.followSystemTheme', value: false }
  ]);
  assert.deepEqual(link.linkedWrites('window.darkMode', 'light'), [
    { key: 'window.followSystemTheme', value: false }
  ]);
});

test('selecting system mode turns follow-system-theme back on', () => {
  const link = require('../src/renderer/js/theme-mode-link.js');

  assert.deepEqual(link.linkedWrites('window.darkMode', 'system'), [
    { key: 'window.followSystemTheme', value: true }
  ]);
});

test('unrelated keys and unknown modes produce no linked writes', () => {
  const link = require('../src/renderer/js/theme-mode-link.js');

  assert.deepEqual(link.linkedWrites('window.alwaysOnTop', true), []);
  assert.deepEqual(link.linkedWrites('window.darkMode', 'invalid'), []);
});

test('settings window schedules the linked writes from the theme-mode select', () => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');

  const handler = source.match(/function handleSelectChange\(key, value\) \{[\s\S]*?\n  \}/);
  assert.ok(handler, 'handleSelectChange must exist');
  assert.match(handler[0], /ThemeModeLink\.linkedWrites\(key, value\)/);
  assert.match(handler[0], /settingsUpdateQueue\.schedule\(linked\.key, linked\.value\)/);
});

test('settings window page loads the theme-mode-link module before settings-window.js', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/settings-window.html'), 'utf8');

  assert.match(
    html,
    /<script src="js\/theme-mode-link\.js"><\/script>\s*<script src="js\/settings-window\.js"><\/script>/
  );
});
