const test = require('node:test');
const assert = require('node:assert/strict');

const {
  UsageFetcher,
  parseCostData,
  parseTokenData,
  localTodayStr
} = require('../src/main/providers/deepseek/usage');

const HISTORICAL_DAY = '2000-01-01';

function usage(cacheHit, cacheMiss, response) {
  return [
    { type: 'PROMPT_TOKEN', amount: '0' },
    { type: 'PROMPT_CACHE_HIT_TOKEN', amount: String(cacheHit) },
    { type: 'PROMPT_CACHE_MISS_TOKEN', amount: String(cacheMiss) },
    { type: 'RESPONSE_TOKEN', amount: String(response) },
    { type: 'REQUEST', amount: '0' }
  ];
}

function payloadForDay(date, cacheHit = 10, cacheMiss = 20, response = 30) {
  const modelUsage = usage(cacheHit, cacheMiss, response);
  return {
    data: {
      biz_data: [{
        total: [{ model: 'deepseek-chat', usage: modelUsage }],
        days: [{
          date,
          data: [{ model: 'deepseek-chat', usage: modelUsage }]
        }]
      }]
    }
  };
}

function emptyPayload() {
  return {
    data: {
      biz_data: [{
        total: [{ model: 'deepseek-chat', usage: usage(0, 0, 0) }],
        days: []
      }]
    }
  };
}

function assertTodayIsZero(cost, amount) {
  assert.equal(cost.aggregate.todayCost, 0);
  assert.equal(amount.aggregate.todayTokens, 0);
  assert.equal(amount.aggregate.todayCacheHit, 0);
  assert.equal(amount.aggregate.todayCacheMiss, 0);
  assert.equal(amount.aggregate.todayCacheRate, 0);
}

test('historical daily data never populates today aggregates', () => {
  const historical = payloadForDay(HISTORICAL_DAY);
  const cost = parseCostData(historical);
  const amount = parseTokenData(historical);

  assert.equal(cost.aggregate.totalCost, 60);
  assert.equal(amount.aggregate.totalTokens, 60);
  assert.equal(cost.dailyData.length, 1);
  assert.equal(amount.dailyData.length, 1);
  assert.equal(cost.dailyData[0].date, HISTORICAL_DAY);
  assert.equal(amount.dailyData[0].date, HISTORICAL_DAY);
  assertTodayIsZero(cost, amount);
});

test('a current-day row with no input tokens has a zero today cache rate', () => {
  const amount = parseTokenData(payloadForDay(localTodayStr(), 0, 0, 5));

  assert.equal(amount.aggregate.todayTokens, 5);
  assert.equal(amount.aggregate.todayCacheHit, 0);
  assert.equal(amount.aggregate.todayCacheMiss, 0);
  assert.equal(amount.aggregate.todayCacheRate, 0);
});

test('previous-month fallback preserves historical totals without contaminating today', async () => {
  const fetcher = new UsageFetcher();
  const currentCost = parseCostData(emptyPayload());
  const currentAmount = parseTokenData(emptyPayload());
  const historicalCost = parseCostData(payloadForDay(HISTORICAL_DAY));
  const historicalAmount = parseTokenData(payloadForDay(HISTORICAL_DAY));
  let costCalls = 0;
  let amountCalls = 0;

  fetcher.fetchUsageCost = async function () {
    costCalls += 1;
    return costCalls === 1 ? currentCost : historicalCost;
  };
  fetcher.fetchUsageAmount = async function () {
    amountCalls += 1;
    return amountCalls === 1 ? currentAmount : historicalAmount;
  };

  const result = await fetcher.fetchUsageWithFallback('token', 8, 2026);

  assert.equal(result.fellBack, true);
  assert.equal(result.month, 7);
  assert.equal(result.year, 2026);
  assert.equal(result.cost.aggregate.totalCost, 60);
  assert.equal(result.amount.aggregate.totalTokens, 60);
  assert.equal(result.cost.dailyData[0].date, HISTORICAL_DAY);
  assert.equal(result.amount.dailyData[0].date, HISTORICAL_DAY);
  assertTodayIsZero(result.cost, result.amount);
});
