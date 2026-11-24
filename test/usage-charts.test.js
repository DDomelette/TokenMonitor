const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUsageCharts, normalizeDays } = require('../src/main/core/usage-charts');

const TODAY = '2026-11-24';

test('usage chart ranges are limited to 7 / 30 / 90 days', () => {
  assert.equal(normalizeDays(7), 7);
  assert.equal(normalizeDays(30), 30);
  assert.equal(normalizeDays(90), 90);
  assert.equal(normalizeDays(1), 30);
  assert.equal(normalizeDays('bad'), 30);
});

test('all charts share zero-filled Beijing dates and interval cumulative values', () => {
  const result = buildUsageCharts({
    today: TODAY,
    days: 7,
    usageDaily: {
      'deepseek:2026-11-18': { total: 100, cached: 40, models: [{ model: 'deepseek-chat', tokens: 100 }] },
      'deepseek:2026-11-24': { total: 50, cached: 20, models: [{ model: 'deepseek-reasoner', tokens: 50 }] },
      'codex:2026-11-24': { total: 25 },
      'kimi:2026-11-23': { total: 10 }
    },
    usageDailyCost: { 'deepseek:2026-11-24': 3.5 }
  });
  assert.equal(result.dates.length, 7);
  assert.equal(result.range.start, '2026-11-18');
  assert.equal(result.range.end, TODAY);
  assert.deepEqual(result.allTokens.daily, [100, 0, 0, 0, 0, 10, 75]);
  assert.deepEqual(result.deepseekTokens.cumulative, [100, 100, 100, 100, 100, 100, 150]);
  assert.deepEqual(result.deepseekCost.daily, [0, 0, 0, 0, 0, 0, 3.5]);
  assert.equal(result.allTokens.total, 185);
  assert.equal(result.providers.find((item) => item.id === 'codex').data[6], 25);
});

test('current DeepSeek official daily rows override stored token and cost rows without double counting', () => {
  const result = buildUsageCharts({
    today: TODAY,
    days: 7,
    usageDaily: { 'deepseek:2026-11-24': { total: 90, models: [{ model: 'old', tokens: 90 }] } },
    usageDailyCost: { 'deepseek:2026-11-24': 9 },
    deepseekStats: {
      tokenDaily: [{ date: TODAY, total: 120, cacheHit: 50, models: [{ model: 'deepseek-chat', tokens: 120 }] }],
      costDaily: [{ date: TODAY, total: 4 }]
    }
  });
  assert.equal(result.deepseekTokens.total, 120);
  assert.equal(result.allTokens.total, 120);
  assert.equal(result.deepseekCost.total, 4);
  assert.deepEqual(result.models[0], { id: 'deepseek-chat', name: 'deepseek-chat', data: [0, 0, 0, 0, 0, 0, 120] });
});

test('model stacking keeps top four and aggregates the rest plus unclassified tokens', () => {
  const models = ['m1', 'm2', 'm3', 'm4', 'm5'].map((name, index) => ({ model: name, tokens: (index + 1) * 10 }));
  const result = buildUsageCharts({
    today: TODAY,
    days: 7,
    usageDaily: {
      'deepseek:2026-11-24': { total: 200, models }
    }
  });
  assert.deepEqual(result.models.map((item) => item.name), ['m5', 'm4', 'm3', 'm2', '其他']);
  assert.equal(result.models[4].data[6], 60, 'm1 10 + 未分类 50');
  assert.equal(result.models.reduce((sum, item) => sum + item.data[6], 0), 200);
});

test('missing model metadata falls back to an explicit unclassified series', () => {
  const result = buildUsageCharts({
    today: TODAY,
    days: 7,
    usageDaily: { 'deepseek:2026-11-24': { total: 80 } }
  });
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].name, '未记录模型');
  assert.equal(result.models[0].data[6], 80);
});
