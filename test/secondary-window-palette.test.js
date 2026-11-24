const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const palette = read('src/shared/palette.css');
const loginHtml = read('src/renderer/login.html');
const loginJs = read('src/renderer/js/login.js');
const diagnosticsHtml = read('src/renderer/diagnostics-window.html');
const diagnosticsCss = read('src/renderer/css/diagnostics.css');
const diagnosticsJs = read('src/renderer/js/diagnostics-window.js');

test('login and diagnostics load the shared palette before their structural styles', () => {
  assert.match(loginHtml, /<link rel="stylesheet" href="\.\.\/shared\/palette\.css">\s*<style>/);
  assert.match(
    diagnosticsHtml,
    /<link rel="stylesheet" href="\.\.\/shared\/palette\.css">\s*<link rel="stylesheet" href="css\/diagnostics\.css">/
  );
  assert.match(loginHtml, /\.container\s*\{[^}]*background:\s*var\(--bg-window\)/);
  assert.match(diagnosticsCss, /#app\s*\{[^}]*background:\s*var\(--bg-window\)/);
});

test('secondary-window structure has no private fixed colors or retired palette aliases', () => {
  assert.doesNotMatch(loginHtml, /#[\da-f]{3,8}\b|rgba?\(/i);
  assert.doesNotMatch(diagnosticsCss, /#[\da-f]{3,8}\b|rgba?\(/i);
  assert.doesNotMatch(diagnosticsCss, /var\(--(?:bg-surface|primary-hover|shadow)\)/);
  assert.doesNotMatch(diagnosticsCss, /body(?:\.dark|\[data-theme=)[\s\S]*?--(?:bg-window|bg-card|primary):/);

  for (const token of [
    '--control-disabled', '--bg-muted',
    '--window-close-hover-bg', '--window-close-hover-text',
    '--status-success-text', '--status-success-bg',
    '--status-warning-text', '--status-warning-bg',
    '--status-danger-text', '--status-danger-bg'
  ]) {
    assert.ok(palette.includes(token + ':'), token + ' must be registered');
  }

  assert.match(loginHtml, /\.btn-primary:disabled\s*\{[^}]*var\(--control-disabled\)/);
  assert.match(loginHtml, /\.error-msg\s*\{[^}]*var\(--status-danger-text\)/);
  assert.match(diagnosticsCss, /\.titlebar-btn:hover\s*\{[^}]*var\(--window-close-hover-text\)[^}]*var\(--window-close-hover-bg\)/);
  assert.match(diagnosticsCss, /\.status-pass \.diagnostic-status\s*\{[^}]*var\(--status-success-text\)[^}]*var\(--status-success-bg\)/);
  assert.match(diagnosticsCss, /\.status-running \.diagnostic-status\s*\{[^}]*var\(--status-warning-text\)[^}]*var\(--status-warning-bg\)/);
  assert.match(diagnosticsCss, /\.status-fail \.diagnostic-status\s*\{[^}]*var\(--status-danger-text\)[^}]*var\(--status-danger-bg\)/);
  assert.match(diagnosticsCss, /\.status-pending \.diagnostic-status,[\s\S]*?var\(--text-secondary\)[^}]*var\(--bg-muted\)/);
});

test('login and diagnostics write theme and focus state to the palette root', () => {
  for (const source of [loginJs, diagnosticsJs]) {
    assert.match(source, /document\.documentElement\.dataset\.theme = theme;/);
    assert.match(source, /document\.documentElement\.style\.colorScheme = isDark \? 'dark' : 'light';/);
    assert.match(source, /document\.documentElement\.dataset\.windowActive = active;/);
    assert.match(source, /document\.body\.dataset\.windowActive = active;/);
  }
});

test('diagnostic status badges keep at least 4.5 to 1 contrast in all five themes', () => {
  const declarations = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block = palette.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
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
  const darkVariables = { ...rootVariables, ...declarations(":root[data-theme$='dark']") };
  const themes = {
    light: rootVariables,
    dark: darkVariables,
    'acrylic-light': { ...rootVariables, ...declarations(":root[data-theme='acrylic-light']") },
    'acrylic-dark': { ...darkVariables, ...declarations(":root[data-theme='acrylic-dark']") },
    'shen-chan': { ...rootVariables, ...declarations(":root[data-theme='shen-chan']") }
  };

  for (const [theme, variables] of Object.entries(themes)) {
    for (const status of ['success', 'warning', 'danger']) {
      const ratio = contrast(variables[`status-${status}-text`], variables[`status-${status}-bg`]);
      assert.ok(ratio >= 4.5, `${theme} ${status} badge contrast ${ratio.toFixed(2)} must be at least 4.5`);
    }
  }
});
