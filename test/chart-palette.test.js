const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const paletteCss = read('src/shared/palette.css');

function fakeStyles(values) {
  return { getPropertyValue: (token) => values[token] || '' };
}

test('semantic palette registers every chart family and theme variant', () => {
  for (const token of [
    '--provider-deepseek', '--provider-codex', '--provider-kimi', '--provider-dsh',
    '--chart-model-1', '--chart-model-2', '--chart-model-3', '--chart-model-4', '--chart-model-5',
    '--chart-cost', '--chart-grid', '--chart-tooltip-bg', '--chart-tooltip-text',
    '--heatmap-l0', '--heatmap-l1', '--heatmap-l2', '--heatmap-l3', '--heatmap-l4', '--heatmap-stacked'
  ]) {
    assert.ok(paletteCss.includes(token + ':'), token + ' must be registered');
  }
  assert.match(paletteCss, /:root\[data-theme\$='dark'\]/);
  const shen = paletteCss.match(/:root\[data-theme='shen-chan'\]\s*\{([^}]+)\}/);
  assert.ok(shen);
  assert.match(shen[1], /--primary:\s*#4DB3E6/);
  assert.match(shen[1], /--chart-tooltip-text:\s*#2B3A6E/);
  assert.match(shen[1], /--chart-tooltip-bg:\s*rgba\(255, 253, 248/);
  assert.match(read('renderer/src/main.jsx'), /import '\.\/shen-chan\.css';\s*import '\.\.\/\.\.\/src\/shared\/palette\.css';/);
});

test('semantic chart reader resolves registered tokens for canvas and DOM legends', async () => {
  const { getSemanticChartTheme, colorWithAlpha } = await import('../renderer/src/lib/chartTheme.js');
  const palette = getSemanticChartTheme(false, fakeStyles({
    '--primary': '#4DB3E6',
    '--text-secondary': '#43568F',
    '--text-primary': '#2B3A6E',
    '--border': '#D9DEEE',
    '--chart-grid': 'rgba(67, 86, 143, 0.12)',
    '--chart-tooltip-bg': '#FFFDF8',
    '--chart-tooltip-text': '#2B3A6E',
    '--provider-deepseek': '#6E94F5',
    '--provider-codex': '#F2A05C',
    '--provider-kimi': '#4ECB94',
    '--provider-dsh': '#A78BFA',
    '--chart-model-1': '#6E94F5'
  }));
  assert.equal(palette.primary, '#4DB3E6');
  assert.equal(palette.textColor, '#43568F');
  assert.equal(palette.tooltipBg, '#FFFDF8');
  assert.equal(palette.modelColors[0], '#6E94F5');
  assert.equal(palette.providerColors.codex, '#F2A05C');
  assert.equal(colorWithAlpha('#4DB3E6', 0.24), 'rgba(77,179,230,0.24)');
  assert.equal(colorWithAlpha('rgb(77, 179, 230)', 0), 'rgba(77,179,230,0)');
});

test('speed chart consumes semantic colors and has readable full-card axes', async () => {
  const { getSemanticChartTheme } = await import('../renderer/src/lib/chartTheme.js');
  const { buildTokenSpeedOption } = await import('../renderer/src/lib/token-speed-chart.js');
  const theme = getSemanticChartTheme(false, fakeStyles({
    '--chart-grid': '#D9DEEE',
    '--chart-cursor': '#80B9D2',
    '--chart-tooltip-bg': '#FFFDF8',
    '--chart-tooltip-text': '#2B3A6E',
    '--provider-deepseek': '#123456',
    '--provider-codex': '#F2A05C',
    '--provider-kimi': '#4ECB94',
    '--provider-dsh': '#A78BFA'
  }));
  const option = buildTokenSpeedOption({
    providerFilter: 'deepseek',
    series: { deepseek: [{ time: 1, tokensPerMinute: 20 }] }
  }, { theme, compact: false });
  assert.equal(option.series[0].lineStyle.color, '#123456');
  assert.equal(option.series[0].areaStyle.color.colorStops[0].color, 'rgba(18,52,86,0.24)');
  assert.equal(option.tooltip.backgroundColor, '#FFFDF8');
  assert.equal(option.tooltip.textStyle.color, '#2B3A6E');
  assert.equal(option.yAxis.splitLine.lineStyle.color, '#D9DEEE');
  assert.equal(option.xAxis.show, true);
  assert.equal(option.yAxis.show, true);
  const compact = buildTokenSpeedOption({}, { theme, compact: true });
  assert.equal(compact.xAxis.show, false);
  assert.equal(compact.yAxis.show, false);
});

test('chart components reference the palette instead of private hard-coded series colors', () => {
  const heatmap = read('renderer/src/components/TokenHeatmap.jsx');
  const speed = read('renderer/src/components/TokenSpeedCard.jsx');
  const trends = read('renderer/src/components/ChartWidget.jsx');
  const providers = read('renderer/src/components/ProviderBar.jsx');
  assert.doesNotMatch(heatmap, /rgba\(|#[\da-f]{3,8}\b/i);
  assert.match(heatmap, /var\(--heatmap-l/);
  assert.match(heatmap, /var\(--heatmap-stacked\)/);
  assert.match(speed, /theme\.providerColors\[providerId\]/);
  assert.match(speed, /useSemanticChartTheme/);
  assert.match(trends, /theme\.modelColors/);
  assert.match(trends, /colorWithAlpha\(trendColor/);
  assert.match(providers, /theme\.providerColors\[provider\.id\]/);
  const css = read('renderer/src/styles.css');
  const tooltip = css.slice(css.indexOf('.heatmap-tooltip {'), css.indexOf('@keyframes heatmap-tip-in'));
  assert.match(tooltip, /var\(--chart-tooltip-bg\)/);
  assert.match(tooltip, /var\(--chart-tooltip-text\)/);
  assert.doesNotMatch(tooltip, /rgba\(|#fff\b/i);
});


test('fee, quota, mini cards and provider health consume the same semantic registry', async () => {
  for (const token of [
    '--status-success', '--status-warning', '--status-danger', '--on-accent',
    '--fee-card-glow', '--fee-card-glow-hover', '--quota-track', '--quota-empty-stripe',
    '--quota-stale-bg', '--quota-stale-border', '--mini-ring-track', '--mini-control-hover',
    '--mini-strip-track', '--shen-card-veil', '--shen-quota-safe-alt',
    '--shen-quota-warning-alt', '--shen-quota-danger-alt'
  ]) {
    assert.ok(paletteCss.includes(token + ':'), token + ' must be registered');
  }

  const { providerColor } = await import('../renderer/src/lib/chartTheme.js');
  assert.equal(providerColor('codex'), 'var(--provider-codex)');
  assert.equal(providerColor('missing'), 'var(--primary)');

  const styles = read('renderer/src/styles.css');
  assert.match(styles, /\.fee-card-surface\s*\{[^}]*var\(--fee-card-glow\)/);
  assert.match(styles, /\.quota-bar-fill\.low\s*\{[^}]*var\(--status-success\)/);
  assert.match(styles, /\.quota-bar-fill\.mid\s*\{[^}]*var\(--status-warning\)/);
  assert.match(styles, /\.quota-bar-fill\.high\s*\{[^}]*var\(--status-danger\)/);
  assert.match(styles, /\.quota-stale-banner\s*\{[^}]*var\(--quota-stale-bg\)/);
  assert.doesNotMatch(styles, /var\(--(?:success|warning|error)\b/);

  const health = read('renderer/src/provider-health.css');
  assert.match(health, /--provider-health-warning:\s*var\(--status-warning\)/);
  assert.match(health, /--provider-health-error:\s*var\(--status-danger\)/);
  const shen = read('renderer/src/shen-chan.css');
  assert.doesNotMatch(shen, /linear-gradient\(rgba\(255, 253, 248/);
  assert.match(shen, /var\(--shen-card-veil\)/);
  assert.match(shen, /:root\[data-theme='shen-chan'\] \.quota-bar-fill\.empty\s*\{[^}]*var\(--status-danger\)[^}]*var\(--quota-empty-stripe\)/);
});
