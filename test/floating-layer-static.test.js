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
