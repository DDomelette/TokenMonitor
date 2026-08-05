const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const themeCss = fs.readFileSync(path.join(root, 'renderer/src/theme.css'), 'utf8');
const dashboard = fs.readFileSync(
  path.join(root, 'renderer/src/components/Dashboard.jsx'),
  'utf8'
);

// 暗色卡片底色只能刷在 component-surface(圆角卡片本体)上。
// .chart-widget 是 grid-stack-item 外层 section(无圆角),刷底色会在圆角卡片
// 后面垫出方形色块;.quota-card 是嵌套组件根,会压过 .embed-surface 的透明规则
// 形成内层直角色块。两者叠加即暗色下的"分层/多余直角边"。
test('dark surface background applies only to the rounded component-surface card', () => {
  const rule = themeCss.match(
    /:root\[data-theme='dark'\] ([^{]+)\{\s*background: var\(--bg-card\);/
  );
  assert.ok(rule, 'dark bg-card rule must exist');
  const selectors = rule[1].split(',').map((s) => s.trim());
  assert.deepEqual(selectors, ['.component-surface']);
});

test('dark theme never paints the grid-item wrapper or nested component roots', () => {
  assert.doesNotMatch(themeCss, /\[data-theme='dark'\][^{]*\.chart-widget(?![\w-])/);
  assert.doesNotMatch(themeCss, /\[data-theme='dark'\][^{]*\.quota-card(?![\w-])/);
  assert.doesNotMatch(themeCss, /\[data-theme='dark'\][^{]*\.stat-card(?![\w-])/);
  assert.doesNotMatch(themeCss, /\[data-theme='dark'\][^{]*\.provider-bar(?![\w-])/);
  assert.doesNotMatch(themeCss, /\[data-theme='dark'\][^{]*\.token-heatmap(?![\w-])/);
});

test('chart-widget class marks the outer grid-stack-item section, not a paintable card', () => {
  assert.match(dashboard, /grid-stack-item ' \+ \(FEE_IDS\.includes\(item\.id\) \? 'fee-card-widget' : 'chart-widget'\)/);
});
