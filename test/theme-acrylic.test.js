const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('main-window resolveTheme maps explicit acrylic modes regardless of system theme', async () => {
  const { resolveTheme } = await import('../renderer/src/theme-sync.js');

  assert.equal(
    resolveTheme({ window: { followSystemTheme: false, darkMode: 'acrylic-light' } }, true),
    'acrylic-light'
  );
  assert.equal(
    resolveTheme({ window: { followSystemTheme: false, darkMode: 'acrylic-dark' } }, false),
    'acrylic-dark'
  );
  // 跟随系统主开关仍然优先:开着时忽略手动亚克力选择
  assert.equal(
    resolveTheme({ window: { followSystemTheme: true, darkMode: 'acrylic-dark' } }, false),
    'light'
  );
});

test('theme-mode-link resolveTheme mirrors acrylic mapping and linkedWrites covers acrylic', () => {
  const link = require('../src/renderer/js/theme-mode-link.js');

  assert.equal(link.resolveTheme({ followSystemTheme: false, darkMode: 'acrylic-light' }, true), 'acrylic-light');
  assert.equal(link.resolveTheme({ followSystemTheme: false, darkMode: 'acrylic-dark' }, false), 'acrylic-dark');
  assert.deepEqual(link.linkedWrites('window.darkMode', 'acrylic-light'), [
    { key: 'window.followSystemTheme', value: false }
  ]);
  assert.deepEqual(link.linkedWrites('window.darkMode', 'acrylic-dark'), [
    { key: 'window.followSystemTheme', value: false }
  ]);
});

test('acrylic-dark also activates the shared dark hooks (body.dark) for charts and secondary windows', async () => {
  const { installThemeSync } = await import('../renderer/src/theme-sync.js');
  const values = new Set();
  const fakeClassList = {
    toggle(name, enabled) { if (enabled) values.add(name); else values.delete(name); },
    contains(name) { return values.has(name); }
  };
  const rootEl = { dataset: {}, style: {}, classList: fakeClassList };
  const bodyEl = { dataset: {}, style: {}, classList: fakeClassList };

  installThemeSync({
    getSettings: async () => ({ window: { followSystemTheme: false, darkMode: 'acrylic-dark' } }),
    mediaQuery: { matches: false, addEventListener() {}, removeEventListener() {} },
    root: rootEl,
    body: bodyEl
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rootEl.dataset.theme, 'acrylic-dark');
  assert.equal(bodyEl.classList.contains('dark'), true);
  assert.equal(rootEl.style.colorScheme, 'acrylic-dark');
});

test('acrylic themes ship semi-transparent window and card surfaces', () => {
  const css = fs.readFileSync(path.join(root, 'renderer/src/theme.css'), 'utf8');

  assert.match(css, /:root\[data-theme='acrylic-light'\]/);
  assert.match(css, /:root\[data-theme='acrylic-dark'\]/);
  assert.match(css, /\[data-theme='acrylic-light'\][\s\S]*?--bg-card: rgba\(255, 255, 255, 0\.[1-6]/);
  assert.match(css, /\[data-theme='acrylic-dark'\][\s\S]*?--bg-card: rgba\(255, 255, 255, 0\.0/);
  // 窗口底色高透,透出 DWM acrylic 磨砂
  assert.match(css, /\[data-theme='acrylic-light'\][\s\S]*?--bg-window: rgba\(255, 255, 255, 0\.[12]/);
  assert.match(css, /\[data-theme='acrylic-dark'\][\s\S]*?--bg-window: rgba\(20, 22, 28, 0\.[23]/);
});

test('settings offers acrylic as explicit theme-mode options', () => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/js/settings-definitions.js'), 'utf8');

  assert.match(source, /\{ value: 'acrylic-light', label: '亚克力\(亮\)' \}/);
  assert.match(source, /\{ value: 'acrylic-dark', label: '亚克力\(暗\)' \}/);
});

test('settings and login windows treat acrylic-dark as dark', () => {
  const settings = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');
  const login = fs.readFileSync(path.join(root, 'src/renderer/js/login.js'), 'utf8');

  assert.match(settings, /theme === 'dark' \|\| theme === 'acrylic-dark'/);
  assert.match(login, /theme === 'dark' \|\| theme === 'acrylic-dark'/);
});
