const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const { fetchUsageCost, fetchUsageAmount, fetchUsageWithFallback, localTodayStr } = require('../src/main/fetcher');

function mockHttpsResponse(statusCode, body) {
  const original = https.request;
  let captured = null;
  https.request = function (options, callback) {
    captured = options;
    const req = new EventEmitter();
    req.setTimeout = function () {};
    req.destroy = function () {};
    req.end = function () {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      callback(res);
      process.nextTick(function () {
        res.emit('data', body);
        res.emit('end');
      });
    };
    return req;
  };
  return {
    getPath() { return captured && captured.path; },
    restore() { https.request = original; }
  };
}

// returns consecutive responses in request order
function mockHttpsSequence(bodies) {
  const original = https.request;
  const paths = [];
  let index = 0;
  https.request = function (options, callback) {
    paths.push(options.path);
    const req = new EventEmitter();
    req.setTimeout = function () {};
    req.destroy = function () {};
    req.end = function () {
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      process.nextTick(function () {
        const body = bodies[Math.min(index, bodies.length - 1)];
        index++;
        res.emit('data', body);
        res.emit('end');
      });
    };
    return req;
  };
  return {
    paths() { return paths.slice(); },
    restore() { https.request = original; }
  };
}

const TODAY = localTodayStr();
const YESTERDAY = '2026-07-30'; // fixed past date, never equals today

const USAGE_CHAT = [
  { type: 'PROMPT_TOKEN', amount: '0' },
  { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '100' },
  { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '200' },
  { type: 'RESPONSE_TOKEN', amount: '300' },
  { type: 'REQUEST', amount: '0' }
];
const USAGE_REASONER = [
  { type: 'PROMPT_TOKEN', amount: '0' },
  { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '10' },
  { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '20' },
  { type: 'RESPONSE_TOKEN', amount: '30' },
  { type: 'REQUEST', amount: '0' }
];

function responseBody(dayData) {
  return JSON.stringify({
    code: 0,
    msg: '',
    data: {
      biz_code: 0,
      biz_msg: '',
      biz_data: [{
        total: [
          { model: 'deepseek-chat', usage: USAGE_CHAT },
          { model: 'deepseek-reasoner', usage: USAGE_REASONER }
        ],
        days: [
          { date: YESTERDAY, data: [{ model: 'deepseek-chat', usage: [
            { type: 'PROMPT_TOKEN', amount: '0' },
            { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '10' },
            { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '20' },
            { type: 'RESPONSE_TOKEN', amount: '30' },
            { type: 'REQUEST', amount: '0' }
          ] }] },
          { date: TODAY, data: [{ model: 'deepseek-chat', usage: [
            { type: 'PROMPT_TOKEN', amount: '0' },
            { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '1' },
            { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '2' },
            { type: 'RESPONSE_TOKEN', amount: '3' },
            { type: 'REQUEST', amount: '0' }
          ] }] }
        ]
      }]
    }
  });
}

test('fetchUsageCost requests the legacy month/year cost endpoint', async () => {
  const mock = mockHttpsResponse(200, responseBody());
  try {
    await fetchUsageCost('token', 8, 2026);
    assert.equal(mock.getPath(), '/api/v0/usage/cost?month=8&year=2026');
  } finally {
    mock.restore();
  }
});

test('fetchUsageAmount requests the legacy month/year amount endpoint', async () => {
  const mock = mockHttpsResponse(200, responseBody());
  try {
    await fetchUsageAmount('token', 8, 2026);
    assert.equal(mock.getPath(), '/api/v0/usage/amount?month=8&year=2026');
  } finally {
    mock.restore();
  }
});

test('cost parsing reads legacy total + days structure', async () => {
  const mock = mockHttpsResponse(200, responseBody());
  try {
    const r = await fetchUsageCost('token', 8, 2026);
    assert.equal(r.aggregate.totalCost, 660);
    assert.equal(r.aggregate.todayCost, 6);
    assert.deepEqual(r.aggregate.models, [
      { model: 'deepseek-chat', cost: 600 },
      { model: 'deepseek-reasoner', cost: 60 }
    ]);
    assert.equal(r.dailyData.length, 2);
    const byDate = {};
    r.dailyData.forEach(function (d) { byDate[d.date] = d; });
    assert.equal(byDate[TODAY].total, 6);
    assert.equal(byDate[YESTERDAY].total, 60);
  } finally {
    mock.restore();
  }
});

test('token parsing reads legacy total + days structure', async () => {
  const mock = mockHttpsResponse(200, responseBody());
  try {
    const r = await fetchUsageAmount('token', 8, 2026);
    assert.equal(r.aggregate.totalTokens, 660);
    assert.equal(r.aggregate.todayTokens, 6);
    assert.equal(r.aggregate.cacheHit, 110);
    assert.equal(r.aggregate.cacheMiss, 220);
    assert.equal(r.aggregate.todayCacheHit, 1);
    assert.equal(r.aggregate.todayCacheMiss, 2);
    assert.ok(Math.abs(r.aggregate.cacheRate - 100 / 3) < 1e-9);
    assert.ok(Math.abs(r.aggregate.todayCacheRate - 100 / 3) < 1e-9);
    assert.deepEqual(r.aggregate.models, [
      { model: 'deepseek-chat', tokens: 600 },
      { model: 'deepseek-reasoner', tokens: 60 }
    ]);
    const byDate = {};
    r.dailyData.forEach(function (d) { byDate[d.date] = d; });
    assert.equal(byDate[TODAY].total, 6);
    assert.equal(byDate[TODAY].cacheHit, 1);
    assert.equal(byDate[TODAY].cacheMiss, 2);
    assert.equal(byDate[TODAY].completion, 3);
    assert.equal(byDate[YESTERDAY].total, 60);
    assert.equal(byDate[TODAY].models.length, 1);
    assert.equal(byDate[TODAY].models[0].model, 'deepseek-chat');
  } finally {
    mock.restore();
  }
});

function zeroResponseBody() {
  return JSON.stringify({
    code: 0,
    msg: '',
    data: {
      biz_code: 0,
      biz_msg: '',
      biz_data: [{
        total: [
          { model: 'deepseek-chat', usage: [
            { type: 'PROMPT_TOKEN', amount: '0' },
            { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '0' },
            { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '0' },
            { type: 'RESPONSE_TOKEN', amount: '0' },
            { type: 'REQUEST', amount: '0' }
          ] }
        ],
        days: []
      }]
    }
  });
}

test('fetchUsageWithFallback keeps current month when it has data', async () => {
  const mock = mockHttpsSequence([responseBody(), responseBody()]);
  try {
    const r = await fetchUsageWithFallback('token', 8, 2026);
    assert.equal(r.fellBack, false);
    assert.equal(r.month, 8);
    assert.equal(r.year, 2026);
    assert.equal(r.cost.aggregate.totalCost, 660);
    assert.equal(r.amount.aggregate.totalTokens, 660);
    assert.equal(mock.paths().length, 2);
    assert.equal(mock.paths()[0], '/api/v0/usage/cost?month=8&year=2026');
    assert.equal(mock.paths()[1], '/api/v0/usage/amount?month=8&year=2026');
  } finally {
    mock.restore();
  }
});

test('fetchUsageWithFallback falls back to previous month when current month is empty', async () => {
  const mock = mockHttpsSequence([zeroResponseBody(), zeroResponseBody(), responseBody(), responseBody()]);
  try {
    const r = await fetchUsageWithFallback('token', 8, 2026);
    assert.equal(r.fellBack, true);
    assert.equal(r.month, 7);
    assert.equal(r.year, 2026);
    assert.equal(r.cost.aggregate.totalCost, 660);
    assert.equal(r.amount.aggregate.totalTokens, 660);
    assert.equal(mock.paths().length, 4);
    assert.equal(mock.paths()[2], '/api/v0/usage/cost?month=7&year=2026');
    assert.equal(mock.paths()[3], '/api/v0/usage/amount?month=7&year=2026');
  } finally {
    mock.restore();
  }
});

test('fetchUsageWithFallback crosses year boundary from January to December', async () => {
  const mock = mockHttpsSequence([zeroResponseBody(), zeroResponseBody(), responseBody(), responseBody()]);
  try {
    const r = await fetchUsageWithFallback('token', 1, 2026);
    assert.equal(r.fellBack, true);
    assert.equal(r.month, 12);
    assert.equal(r.year, 2025);
    assert.equal(mock.paths()[2], '/api/v0/usage/cost?month=12&year=2025');
  } finally {
    mock.restore();
  }
});

test('empty or null biz_data resolves to empty aggregate instead of throwing', async () => {
  const mock = mockHttpsResponse(200, JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: [] } }));
  try {
    const cost = await fetchUsageCost('token', 8, 2026);
    assert.equal(cost.aggregate.totalCost, 0);
    assert.deepEqual(cost.dailyData, []);
    const amount = await fetchUsageAmount('token', 8, 2026);
    assert.equal(amount.aggregate.totalTokens, 0);
    assert.deepEqual(amount.dailyData, []);
  } finally {
    mock.restore();
  }
});
