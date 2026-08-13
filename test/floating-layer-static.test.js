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

// 静态计数无法区分 tooltip 配置"定义"与"引用"(如 ChartWidget 的 curveTooltip 助手
// 被 CURVE_CONFIGS 引用),故守卫用两条不变式而非 plan 里的逐 tooltip 计数:
// 1) 每个 appendToBody 定义必须与窗口钳制 position 成对(数量相等);
// 2) 内联 `tooltip: {` 字面量必须有 appendToBody 覆盖(appendToBody 数 >= 内联定义数)。
// chartTheme.js 的 tooltip 块只作样式源(消费方一律整体覆盖 tooltip 配置),
// 列入 STYLE_ONLY,要求不含行为键,防止被误当成真实配置。
const STYLE_ONLY_TOOLTIP_FILES = ['renderer/src/lib/chartTheme.js'];

test('every ECharts tooltip in renderer appends to body and clamps position', () => {
  const dirs = ['renderer/src/components', 'renderer/src/lib'];
  const files = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(path.resolve(__dirname, '..', dir))) {
      if (/\.(js|jsx)$/.test(name)) files.push(dir + '/' + name);
    }
  }
  for (const file of files) {
    const source = read(file);
    const appends = source.match(/appendToBody: true/g) || [];
    const positions = source.match(/position: (echartsWindowPosition|windowClampedPosition)\(/g) || [];
    if (STYLE_ONLY_TOOLTIP_FILES.includes(file)) {
      assert.equal(appends.length, 0, file + ': style-only tooltip block must not carry behavior keys');
      continue;
    }
    const inlineDefs = source.match(/\btooltip:\s*\{/g) || [];
    assert.equal(appends.length, positions.length,
      file + ': every appendToBody tooltip must pair with a window-clamped position callback');
    assert.ok(appends.length >= inlineDefs.length,
      file + ': every inline tooltip definition needs appendToBody: true');
  }
});
