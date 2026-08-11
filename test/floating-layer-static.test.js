const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

test('token-speed tooltip appends to body and clamps position into the window', () => {
  const source = read('renderer/src/lib/token-speed-chart.js');
  const tooltip = source.match(/tooltip:\s*\{[\s\S]*?\n    \},/);
  assert.ok(tooltip, 'tooltip config block should exist');
  assert.match(tooltip[0], /appendToBody: true/);
  assert.match(tooltip[0], /position: echartsWindowPosition\(/);
});

test('token speed card passes its chart dom for position clamping', () => {
  const source = read('renderer/src/components/TokenSpeedCard.jsx');
  assert.match(source, /dom: chartRef\.current/);
});

test('ChartWidget re-exports the shared windowClampedPosition from floating-layer', () => {
  const source = read('renderer/src/components/ChartWidget.jsx');
  assert.match(source, /import \{ echartsWindowPosition as windowClampedPosition \} from '\.\.\/lib\/floating-layer\.js'/);
  assert.match(source, /export \{ windowClampedPosition \}/);
  assert.doesNotMatch(source, /export function windowClampedPosition/);
});

test('heatmap tooltip uses shared clamp and flip primitives', () => {
  const source = read('renderer/src/components/TokenHeatmap.jsx');
  assert.match(source, /import \{ clampToWindow, resolveVerticalFlip \} from '\.\.\/lib\/floating-layer\.js'/);
  assert.doesNotMatch(source, /clampTipX = \(x\) => Math\.max/);
  assert.doesNotMatch(source, /r\.top < 140/);
});

test('custom select menu uses shared flip decision', () => {
  const source = read('renderer/src/components/CustomSelect.jsx');
  assert.match(source, /import \{ resolveVerticalFlip \} from '\.\.\/lib\/floating-layer\.js'/);
  assert.match(source, /resolveVerticalFlip\(rect, menuHeight/);
});
