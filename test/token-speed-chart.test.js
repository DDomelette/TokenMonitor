const test = require('node:test');
const assert = require('node:assert/strict');

test('all mode creates three smooth non-connecting platform curves', async () => {
  const chart = await import('../renderer/src/lib/token-speed-chart.js');
  const snapshot = {
    providerFilter: 'all',
    series: {
      deepseek: [{ time: 1, tokensPerMinute: 100, deltaTokens: 20, quality: 'fresh' }],
      codex: [{ time: 1, tokensPerMinute: 50, deltaTokens: 10, quality: 'offline' }],
      kimi: [{ time: 1, tokensPerMinute: null, deltaTokens: null, quality: 'collecting' }]
    }
  };
  const option = chart.buildTokenSpeedOption(snapshot, { isDark: true, compact: false });
  assert.deepEqual(option.series.map((item) => item.name), ['DeepSeek', 'Codex', 'Kimi']);
  assert.deepEqual(option.series.map((item) => item.lineStyle.color), ['#6E94F5', '#F2A05C', '#4ECB94']);
  assert.ok(option.series.every((item) => item.smooth === true && item.connectNulls === false));
  assert.equal(option.series[2].data[0].value[1], null);
});

test('single-provider mode creates one stronger area curve', async () => {
  const chart = await import('../renderer/src/lib/token-speed-chart.js');
  const snapshot = {
    providerFilter: 'codex',
    series: { codex: [{ time: 1, tokensPerMinute: 1200, deltaTokens: 600, quality: 'fresh' }] }
  };
  const option = chart.buildTokenSpeedOption(snapshot, { isDark: false, compact: false });
  assert.equal(option.series.length, 1);
  assert.equal(option.series[0].name, 'Codex');
  assert.ok(option.series[0].areaStyle.opacity > 0.1);
  assert.equal(chart.formatTokenRate(24600), '24.6K/min');
});
