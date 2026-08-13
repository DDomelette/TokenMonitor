const test = require('node:test');
const assert = require('node:assert/strict');

const { getDshModelPrice, calcDshCost, DSH_PRICING } = require('../src/main/pricing');

test('calcDshCost prices the four raw telemetry buckets', () => {
  // deepseek-v4-pro: input 0.001, output 0.004, cacheHit 0.0001 per 1000 tokens.
  const cost = calcDshCost('deepseek-v4-pro', 1000, 2000, 3000, 100);
  assert.equal(cost, 1 * 0.001 + 2 * 0.004 + 3 * 0.0001 + 0.1 * 0.001);
});

test('calcDshCost bills cache writes at the input price', () => {
  const cost = calcDshCost('deepseek-v4-pro', 0, 0, 0, 1000);
  assert.equal(cost, 0.001);
});

test('getDshModelPrice resolves prefix matches and the default row', () => {
  assert.equal(getDshModelPrice('deepseek-v4-pro-20260101').cacheHit, DSH_PRICING['deepseek-v4-pro'].cacheHit);
  assert.equal(getDshModelPrice('some-future-model'), DSH_PRICING.default);
  assert.equal(getDshModelPrice(''), DSH_PRICING.default);
  assert.equal(getDshModelPrice(null), DSH_PRICING.default);
});

test('existing PRICING and calcCost are untouched', () => {
  const { calcCost, getModelPrice } = require('../src/main/pricing');
  assert.equal(calcCost('deepseek-v4-pro', 1000, 2000, 3000), 1 * 0.001 + 2 * 0.004 + 3 * 0.0001);
  assert.equal(getModelPrice('deepseek-reasoner'), require('../src/main/pricing').PRICING['deepseek-reasoner']);
});
