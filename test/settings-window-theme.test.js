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

test('settings primary button text keeps readable contrast in every theme', () => {
  const css = fs.readFileSync(path.join(root, 'src/renderer/css/main.css'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'src/renderer/settings-window.html'), 'utf8');
  const declarations = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
    assert.ok(block, `missing CSS block: ${selector}`);
    return Object.fromEntries(
      Array.from(block[1].matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g), (match) => [match[1], match[2]])
    );
  };
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/.{2}/g).map((value) => parseInt(value, 16) / 255);
    const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const contrast = (foreground, background) => {
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };

  const rootVariables = declarations(':root');
  const lightVariables = declarations('body:not(.dark)');
  const themes = {
    light: { ...rootVariables, ...lightVariables },
    dark: { ...rootVariables, ...declarations('body.dark') },
    'acrylic-light': { ...rootVariables, ...lightVariables, ...declarations("body[data-theme='acrylic-light']") },
    'acrylic-dark': { ...rootVariables, ...declarations('body.dark'), ...declarations("body[data-theme='acrylic-dark']") },
    'shen-chan': { ...rootVariables, ...lightVariables, ...declarations("body[data-theme='shen-chan']") }
  };

  assert.match(html, /\.btn-primary\s*\{[^}]*color:\s*var\(--text-on-primary\)/);
  for (const [name, variables] of Object.entries(themes)) {
    for (const state of ['primary', 'primary-light']) {
      const ratio = contrast(variables['text-on-primary'], variables[state]);
      assert.ok(ratio >= 4.5, `${name} ${state} contrast ${ratio.toFixed(2)} must be at least 4.5`);
    }
  }
});
