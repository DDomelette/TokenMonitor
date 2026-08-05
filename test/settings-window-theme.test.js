const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// 与 renderer/src/theme-sync.js 的 resolveTheme 同一套语义:
// followSystemTheme 是主开关,为 true 时忽略 darkMode 手动值,跟随系统。
test('resolveTheme mirrors the main-window master-switch semantics', () => {
  const link = require('../src/renderer/js/theme-mode-link.js');

  assert.equal(link.resolveTheme({}, false), 'light');
  assert.equal(link.resolveTheme({}, true), 'dark');
  assert.equal(link.resolveTheme({ followSystemTheme: true, darkMode: 'light' }, true), 'dark');
  assert.equal(link.resolveTheme({ followSystemTheme: true, darkMode: 'dark' }, false), 'light');
  assert.equal(link.resolveTheme({ followSystemTheme: false, darkMode: 'dark' }, false), 'dark');
  assert.equal(link.resolveTheme({ followSystemTheme: false, darkMode: 'light' }, true), 'light');
  assert.equal(link.resolveTheme({ followSystemTheme: false, darkMode: 'system' }, true), 'dark');
  assert.equal(link.resolveTheme({ followSystemTheme: false, darkMode: 'invalid' }, false), 'light');
});

test('settings window no longer pins itself to light', () => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');

  assert.doesNotMatch(source, /classList\.remove\('dark'\)/);
});

test('settings window resolves theme from persisted settings and the system media query', () => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');

  assert.match(source, /ThemeModeLink\.resolveTheme\(/);
  assert.match(source, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
  assert.match(source, /classList\.toggle\('dark',/);
});

test('settings window re-applies theme on main-process notifications and system theme changes', () => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');

  const themeListener = source.match(/window\.api\.on\('theme:changed',[\s\S]*?\}\);/);
  assert.ok(themeListener, 'theme:changed listener must exist');
  assert.match(themeListener[0], /applyTheme\(\)/);

  const media = source.match(/matchMedia\('\(prefers-color-scheme: dark\)'\)[\s\S]*?;/);
  assert.ok(media);
  assert.match(source, /addEventListener\('change',/);
});
