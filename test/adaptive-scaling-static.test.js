const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const layoutCss = fs.readFileSync(path.join(root, 'src/renderer/css/layout.css'), 'utf8');
const componentsCss = fs.readFileSync(path.join(root, 'src/renderer/css/components.css'), 'utf8');
const mainCss = fs.readFileSync(path.join(root, 'src/renderer/css/main.css'), 'utf8');

test('widget content is a size container so cqw units resolve per widget', () => {
  const rule = layoutCss.match(/\.grid-stack-item-content\s*\{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /container-type:\s*size/);
});

test('fee card value in card preset scales with container width, not fixed 38px', () => {
  const rule = layoutCss.match(/\[data-layout-preset="card"\]\s*\.fee-card-value\s*\{[^}]*\}/);
  assert.ok(rule);
  assert.doesNotMatch(rule[0], /font-size:\s*38px/);
  assert.match(rule[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
});

test('base fee card value clamps with cqw and crops overflow gracefully', () => {
  const rule = componentsCss.match(/\.fee-card-value\s*\{[^}]*\}/);
  assert.ok(rule);
  assert.match(rule[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
  assert.match(rule[0], /text-overflow:\s*ellipsis/);
});

test('fee card sub text scales with container width', () => {
  const base = componentsCss.match(/\.fee-card-sub\s*\{[^}]*\}/);
  assert.ok(base);
  assert.match(base[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
  const card = layoutCss.match(/\[data-layout-preset="card"\]\s*\.fee-card-sub\s*\{[^}]*\}/);
  assert.ok(card);
  assert.match(card[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
});

test('component titles scale with container width in both base and card preset', () => {
  const base = mainCss.match(/\.component-title\s*\{[^}]*\}/);
  assert.ok(base);
  assert.match(base[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
  const card = layoutCss.match(/\[data-layout-preset="card"\]\s*\.component-title\s*\{[^}]*\}/);
  assert.ok(card);
  assert.match(card[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
});

test('app root is an inline-size container and statusbar text scales with window width', () => {
  const app = mainCss.match(/#app\s*\{[^}]*\}/);
  assert.ok(app);
  assert.match(app[0], /container-type:\s*inline-size/);
  const statusbar = mainCss.match(/\.statusbar\s*\{[^}]*\}/);
  assert.ok(statusbar);
  assert.match(statusbar[0], /font-size:\s*clamp\([^)]*cqw[^)]*\)/);
});
