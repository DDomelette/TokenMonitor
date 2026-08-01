const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const layoutCss = fs.readFileSync(path.join(root, 'src/renderer/css/layout.css'), 'utf8');
const componentsCss = fs.readFileSync(path.join(root, 'src/renderer/css/components.css'), 'utf8');

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
