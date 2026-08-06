const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildSundayWeekTotals,
  buildWeeks,
  colorLevel,
  formatToken,
  sundayWeekKey
} = require('../renderer/src/lib/heatmap.js');

const root = path.resolve(__dirname, '..');
const heatmapJsx = fs.readFileSync(path.join(root, 'renderer/src/components/TokenHeatmap.jsx'), 'utf8');

function localDate(day) {
  return new Date(day + 'T00:00:00');
}

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

test('visual week keys use the Sunday that starts the rendered column', () => {
  assert.equal(sundayWeekKey(localDate('2026-08-02')), '2026-08-02');
  assert.equal(sundayWeekKey(localDate('2026-08-03')), '2026-08-02');
  assert.equal(sundayWeekKey(localDate('2026-08-08')), '2026-08-02');
  assert.equal(sundayWeekKey(localDate('2026-08-09')), '2026-08-09');
});

test('Sunday-only and Monday-only usage aggregate into their visual columns', () => {
  const totals = buildSundayWeekTotals({
    '2026-08-02': 5,
    '2026-08-03': 7,
    '2026-08-09': 11
  });

  assert.deepEqual(totals, {
    '2026-08-02': 12,
    '2026-08-09': 11
  });
});

test('a cross-year column is keyed by its actual Sunday while summing selected-year days', () => {
  const weeks = buildWeeks(2026);
  const firstColumnKey = sundayWeekKey(localDate(weeks[0][0].date));
  const totals = buildSundayWeekTotals({
    '2026-01-01': 4,
    '2026-01-03': 6
  });

  assert.equal(firstColumnKey, '2025-12-28');
  assert.equal(totals[firstColumnKey], 10);
});

test('every weekly total equals the sum of the seven daily cells in that rendered column', () => {
  const weeks = buildWeeks(2026);
  const days = {};

  weeks.forEach((column) => {
    column.forEach((cell, row) => {
      if (cell.inYear) days[cell.date] = row + 1;
    });
  });

  const totals = buildSundayWeekTotals(days);
  weeks.forEach((column) => {
    const key = sundayWeekKey(localDate(column[0].date));
    const expected = column.reduce(
      (sum, cell) => sum + (cell.inYear ? Number(days[cell.date]) || 0 : 0),
      0
    );
    assert.equal(totals[key] || 0, expected, key);
  });
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

test('TokenHeatmap renders visual-week totals without ISO-week aggregation', () => {
  assert.match(heatmapJsx, /buildWeeks/);
  assert.match(heatmapJsx, /buildSundayWeekTotals/);
  assert.match(heatmapJsx, /sundayWeekKey/);
  assert.doesNotMatch(heatmapJsx, /isoWeekKey/);
  assert.match(heatmapJsx, /colorLevel/);
  assert.match(heatmapJsx, /formatToken/);
  assert.match(heatmapJsx, /每日/);
  assert.match(heatmapJsx, /每周/);
  assert.match(heatmapJsx, /累计/);
  assert.match(heatmapJsx, /heatmap-tooltip/);
  assert.match(heatmapJsx, /getHeatmap/);
});

test('TokenHeatmap portals the tooltip to document.body so it escapes the module card', () => {
  // 模块卡片有 overflow:hidden + backdrop-filter(玻璃效果):
  // backdrop-filter 会让卡片成为 position:fixed 后代的包含块,
  // tooltip 若留在模块 DOM 内会被裁剪,且撑大卡片的 scrollHeight,
  // 触发 Dashboard fitItems 自动撑高模块(下边框向下扩张)。
  // 因此 tooltip 必须 portal 到 document.body
  assert.match(heatmapJsx, /createPortal/);
  assert.match(heatmapJsx, /document\.body/);
});

test('TokenHeatmap renders weekly/cumulative as stacked block columns', () => {
  assert.match(heatmapJsx, /blockCount/);
  assert.match(heatmapJsx, /heatmap-grid-blocks/);
  assert.match(heatmapJsx, /heatmap-block-col/);
  assert.match(heatmapJsx, /当周使用了/);
  assert.match(heatmapJsx, /当周累计使用/);
});
