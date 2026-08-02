const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildWeeks, colorLevel, formatToken, isoWeekKey } = require('../renderer/src/lib/heatmap.js');

const root = path.resolve(__dirname, '..');
const heatmapJsx = fs.readFileSync(path.join(root, 'renderer/src/components/TokenHeatmap.jsx'), 'utf8');

test('buildWeeks(2026) starts at the Sunday of the week containing Jan 1 and fills 53 columns', () => {
  const weeks = buildWeeks(2026);
  assert.equal(weeks.length, 53);
  // 2026-01-01 是周四 → 首格为 2025-12-28(周日,不属于本年)
  assert.equal(weeks[0][0].date, '2025-12-28');
  assert.equal(weeks[0][0].inYear, false);
  assert.equal(weeks[0][4].date, '2026-01-01');
  assert.equal(weeks[0][4].inYear, true);
  // 最后一列补足 7 天
  assert.ok(weeks[52].every((cell) => cell && cell.date));
});

test('colorLevel maps four quartiles plus zero', () => {
  assert.equal(colorLevel(0, 100), 0);
  assert.equal(colorLevel(0, 0), 0);
  assert.equal(colorLevel(25, 100), 1);
  assert.equal(colorLevel(51, 100), 3);
  assert.equal(colorLevel(76, 100), 4);
  assert.equal(colorLevel(100, 100), 4);
});

test('formatToken uses 亿 / 万 / thousands separators', () => {
  assert.equal(formatToken(390000000), '3.9亿');
  assert.equal(formatToken(12340000), '1,234万');
  assert.equal(formatToken(8521), '8,521');
});

test('TokenHeatmap renders 53x7 grid with daily/weekly/cumulative tabs and tooltip copy', () => {
  assert.match(heatmapJsx, /buildWeeks/);
  assert.match(heatmapJsx, /colorLevel/);
  assert.match(heatmapJsx, /formatToken/);
  assert.match(heatmapJsx, /每日/);
  assert.match(heatmapJsx, /每周/);
  assert.match(heatmapJsx, /累计/);
  assert.match(heatmapJsx, /个 Token/);
  assert.match(heatmapJsx, /getHeatmap/);
});
