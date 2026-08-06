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
  assert.match(css, /\[data-theme='acrylic-light'\][\s\S]*?--bg-window: rgba\(255, 255, 255, 0\.08\)/);
  assert.match(css, /\[data-theme='acrylic-dark'\][\s\S]*?--bg-window: rgba\(20, 22, 28, 0\.15\)/);
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

test('acrylic cards float above the window with a layered drop shadow', () => {
  const css = fs.readFileSync(path.join(root, 'renderer/src/theme.css'), 'utf8');

  // 亮调:卡片在磨砂底上投出柔和阴影,避免与窗口底"割裂"
  assert.match(css, /\[data-theme='acrylic-light'\][\s\S]*?--shadow-card: 0 4px 16px rgba\(0, 0, 0, 0\.10\), 0 1px 3px rgba\(0, 0, 0, 0\.08\)/);
  // 暗调:阴影更深,拉开卡片与深色磨砂底的层次
  assert.match(css, /\[data-theme='acrylic-dark'\][\s\S]*?--shadow-card: 0 6px 20px rgba\(0, 0, 0, 0\.45\), 0 1px 3px rgba\(0, 0, 0, 0\.30\)/);
  // 亮调卡片基础样式无阴影,亚克力亮调需显式消费 --shadow-card,并加玻璃内高光与背景模糊
  assert.match(css, /:root\[data-theme='acrylic-light'\] \.component-surface \{[^}]*box-shadow: var\(--shadow-card\), inset 0 1px 0 rgba\(255, 255, 255, 0\.35\)/);
  assert.match(css, /:root\[data-theme='acrylic-light'\] \.component-surface \{[^}]*backdrop-filter: blur\(16px\) saturate\(140%\)/);
  assert.match(css, /:root\[data-theme='acrylic-dark'\] \.component-surface \{[^}]*box-shadow: var\(--shadow-card\), inset 0 1px 0 rgba\(255, 255, 255, 0\.08\)/);
});

test('settings window follows the acrylic theme like the main window', () => {
  const js = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src/renderer/css/main.css'), 'utf8');

  assert.match(js, /document\.body\.dataset\.theme = theme;/);
  assert.match(css, /body\[data-theme='acrylic-light'\][\s\S]*?--bg-card: rgba\(255, 255, 255, 0\.28\)/);
  assert.match(css, /body\[data-theme='acrylic-light'\] #app \{\s*background: rgba\(255, 255, 255, 0\.08\)/);
  assert.match(css, /body\[data-theme='acrylic-dark'\][\s\S]*?--bg-window-dark: rgba\(20, 22, 28, 0\.15\)/);
  assert.match(css, /body\[data-theme='acrylic-dark'\][\s\S]*?--bg-card: rgba\(255, 255, 255, 0\.05\)/);
});

test('login window follows the acrylic theme like the main window', () => {
  const js = fs.readFileSync(path.join(root, 'src/renderer/js/login.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/renderer/login.html'), 'utf8');

  assert.match(js, /document\.body\.dataset\.theme = theme;/);
  assert.match(html, /body\[data-theme='acrylic-light'\] \.container \{\s*background: rgba\(255, 255, 255, 0\.08\)/);
  assert.match(html, /body\[data-theme='acrylic-dark'\] \.container \{\s*background: rgba\(20, 22, 28, 0\.15\)/);
});

test('acrylic-light keeps text and titlebar icons readable on the gray-dark backdrop', () => {
  const css = fs.readFileSync(path.join(root, 'renderer/src/theme.css'), 'utf8');

  // 窗口底 0.08 近全透,透出的桌面偏灰黑:标题栏/状态栏文字与图标用白色
  assert.match(css, /:root\[data-theme='acrylic-light'\] \.statusbar \{[^}]*color: rgba\(255, 255, 255, 0\.92\)/);
  assert.match(css, /:root\[data-theme='acrylic-light'\] \.titlebar-btn \{\s*color: rgba\(255, 255, 255, 0\.85\)/);
  // 卡片底回升到 0.55,深色次级文本在白色衬底上保持可读
  assert.match(css, /\[data-theme='acrylic-light'\][\s\S]*?--bg-card: rgba\(255, 255, 255, 0\.55\)/);
  assert.match(css, /\[data-theme='acrylic-light'\][\s\S]*?--text-secondary: #4B5563/);

  // 设置窗口文本直接落在透明窗口底上,整体转白色系
  const mainCss = fs.readFileSync(path.join(root, 'src/renderer/css/main.css'), 'utf8');
  assert.match(mainCss, /body\[data-theme='acrylic-light'\][\s\S]*?--text-primary: #F3F4F6/);
  assert.match(mainCss, /body\[data-theme='acrylic-light'\][\s\S]*?--text-secondary: rgba\(255, 255, 255, 0\.75\)/);
});

test('theme-sync tracks window focus state for the inactive fallback', async () => {
  const { installThemeSync } = await import('../renderer/src/theme-sync.js');
  const rootEl = { dataset: {}, style: {}, classList: { toggle() {}, contains: () => false } };
  const bodyEl = { dataset: {}, style: {}, classList: { toggle() {}, contains: () => false } };
  let focusListener = null;

  installThemeSync({
    getSettings: async () => ({ window: {} }),
    mediaQuery: { matches: false, addEventListener() {}, removeEventListener() {} },
    root: rootEl,
    body: bodyEl,
    onWindowFocusState(cb) { focusListener = cb; return () => {}; }
  });

  assert.equal(typeof focusListener, 'function');
  focusListener(false);
  assert.equal(rootEl.dataset.windowActive, 'false');
  focusListener(true);
  assert.equal(rootEl.dataset.windowActive, 'true');
});

test('acrylic themes ship a deliberate inactive solid fallback', () => {
  const css = fs.readFileSync(path.join(root, 'renderer/src/theme.css'), 'utf8');

  // Accent 不可用时失焦会退化为纯色:主动切成接近常规主题的实底,而不是被动显示 DWM fallback
  assert.match(css, /\[data-theme='acrylic-light'\]\[data-window-active='false'\][\s\S]*?--bg-window: rgba\(246, 247, 249, 0\.93\)/);
  assert.match(css, /\[data-theme='acrylic-dark'\]\[data-window-active='false'\][\s\S]*?--bg-window: rgba\(30, 32, 38, 0\.94\)/);
  // 亮色实底下铬层文字图标回到深灰
  assert.match(css, /\[data-theme='acrylic-light'\]\[data-window-active='false'\][\s\S]*?\.titlebar-btn \{[^}]*color: #5B6372/i);
});

test('settings and login windows ship the same inactive fallback', () => {
  const mainCss = fs.readFileSync(path.join(root, 'src/renderer/css/main.css'), 'utf8');
  const loginHtml = fs.readFileSync(path.join(root, 'src/renderer/login.html'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');
  const login = fs.readFileSync(path.join(root, 'src/renderer/js/login.js'), 'utf8');

  // 设置窗口:失焦实底 + 文字回到深色系
  assert.match(mainCss, /body\[data-theme='acrylic-light'\]\[data-window-active='false'\][\s\S]*?--text-primary: #1A1A2E/);
  assert.match(mainCss, /body\[data-theme='acrylic-light'\]\[data-window-active='false'\] #app \{\s*background: rgba\(255, 255, 255, 0\.93\)/);
  // 登录窗口:失焦实底
  assert.match(loginHtml, /body\[data-theme='acrylic-light'\]\[data-window-active='false'\] \.container \{\s*background: rgba\(255, 255, 255, 0\.93\)/);
  assert.match(loginHtml, /body\[data-theme='acrylic-dark'\]\[data-window-active='false'\] \.container \{\s*background: rgba\(30, 32, 38, 0\.94\)/);
  // 两个窗口都监听焦点通道
  assert.match(settings, /window:focus-state/);
  assert.match(settings, /dataset\.windowActive/);
  assert.match(login, /window:focus-state/);
  assert.match(login, /dataset\.windowActive/);
});
