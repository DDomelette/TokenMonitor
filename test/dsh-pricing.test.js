const test = require('node:test');
const assert = require('node:assert/strict');

const { getDshModelPrice, calcDshCost } = require('../src/main/pricing');

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingMs(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS;
}

test('DSH pricing uses the official rates before the 2026-08-17 effective instant', () => {
  const at = beijingMs(2026, 8, 16, 23, 59);
  assert.deepEqual(getDshModelPrice('deepseek-v4-flash', at), {
    input: 0.001, output: 0.002, cacheHit: 0.00002
  });
  assert.deepEqual(getDshModelPrice('deepseek-v4-pro', at), {
    input: 0.003, output: 0.006, cacheHit: 0.000025
  });
});

test('DSH pricing applies Beijing peak boundaries after the effective instant', () => {
  const cases = [
    [beijingMs(2026, 8, 17, 0, 0), 0.0045],
    [beijingMs(2026, 8, 17, 8, 59), 0.0045],
    [beijingMs(2026, 8, 17, 9, 0), 0.009],
    [beijingMs(2026, 8, 17, 11, 59), 0.009],
    [beijingMs(2026, 8, 17, 12, 0), 0.0045],
    [beijingMs(2026, 8, 17, 13, 59), 0.0045],
    [beijingMs(2026, 8, 17, 14, 0), 0.009],
    [beijingMs(2026, 8, 17, 17, 59), 0.009],
    [beijingMs(2026, 8, 17, 18, 0), 0.0045]
  ];
  cases.forEach(([at, expectedInput]) => {
    assert.equal(getDshModelPrice('deepseek-v4-pro', at).input, expectedInput);
  });
});

test('calcDshCost prices all four raw buckets at the event-time rate', () => {
  const at = beijingMs(2026, 8, 17, 9, 0);
  assert.equal(
    calcDshCost('deepseek-v4-flash', 1000, 2000, 3000, 100, at),
    1 * 0.003 + 2 * 0.009 + 3 * 0.0001 + 0.1 * 0.003
  );
});

test('DSH pricing does not map unlisted reasoner or future models to pro', () => {
  const at = beijingMs(2026, 8, 17, 9, 0);
  assert.equal(getDshModelPrice('deepseek-reasoner', at), undefined);
  assert.equal(getDshModelPrice('some-future-model', at), undefined);
  assert.equal(calcDshCost('deepseek-reasoner', 1000, 0, 0, 0, at), 0);
});

test('existing PRICING and calcCost are untouched', () => {
  const { calcCost, getModelPrice } = require('../src/main/pricing');
  assert.equal(calcCost('deepseek-v4-pro', 1000, 2000, 3000), 1 * 0.001 + 2 * 0.004 + 3 * 0.0001);
  assert.equal(getModelPrice('deepseek-reasoner'), require('../src/main/pricing').PRICING['deepseek-reasoner']);
});
