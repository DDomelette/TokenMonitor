const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('production dashboard does not load the debug overlay', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  assert.doesNotMatch(html, /debug-overlay\.js/);
});

test('dashboard layout code never controls BrowserWindow geometry', () => {
  const layoutDir = path.join(root, 'src/renderer/js/layout');
  if (!fs.existsSync(layoutDir)) return;

  const source = fs.readdirSync(layoutDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => fs.readFileSync(path.join(layoutDir, name), 'utf8'))
    .join('\n');

  assert.doesNotMatch(source, /setBounds|setSize|setPosition|window:commit/);
});
