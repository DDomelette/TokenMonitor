const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('login page loads the shared palette and theme link before semantic styles and behavior', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/login.html'), 'utf8');

  assert.match(html, /<link rel="stylesheet" href="\.\.\/shared\/palette\.css">\s*<style>/);
  assert.match(
    html,
    /<script src="js\/theme-mode-link\.js"><\/script>\s*<script src="js\/login\.js"><\/script>/
  );
  assert.match(html, /\.container\s*\{[^}]*background:\s*var\(--bg-window\)/);
  assert.match(html, /\.form-input\s*\{[^}]*background:\s*var\(--bg-card\)/);
  assert.match(html, /\.form-input:focus\s*\{[^}]*var\(--control-focus-ring\)/);
  assert.doesNotMatch(html, /body\.dark \.(?:container|form-input)/);
});

test('login window resolves theme from persisted settings and the system media query', () => {
  const source = fs.readFileSync(path.join(root, 'src/renderer/js/login.js'), 'utf8');

  assert.match(source, /ThemeModeLink\.resolveTheme\(/);
  assert.match(source, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
  assert.match(source, /classList\.toggle\('dark',/);
  assert.match(source, /window\.api\.invoke\('get:settings'\)/);
  assert.match(source, /window\.api\.on\('theme:changed',/);
  assert.match(source, /addEventListener\('change',/);
});

test('main process includes the login window in theme notifications', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');

  const applyTheme = source.match(/function applyTheme\(\) \{[\s\S]*?\n\}/);
  assert.ok(applyTheme, 'applyTheme must exist');
  assert.match(applyTheme[0], /loginWindow/);

  const nativeThemeListener = source.match(/nativeTheme\.on\('updated',[\s\S]*?\}\);/);
  assert.ok(nativeThemeListener, 'nativeTheme updated listener must exist');
  assert.match(nativeThemeListener[0], /loginWindow/);
});

test('dead legacy chart components are removed', () => {
  assert.equal(
    fs.existsSync(path.join(root, 'src/renderer/js/components/token-line.js')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(root, 'src/renderer/js/components/cost-line.js')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(root, 'src/renderer/js/components/drag-sort.js')),
    false
  );
});
