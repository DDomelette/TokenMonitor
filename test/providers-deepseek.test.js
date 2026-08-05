const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const { UsageFetcher, localTodayStr } = require('../src/main/providers/deepseek/usage');
const { fetchBalance } = require('../src/main/providers/deepseek/balance');
const deepseekAdapter = require('../src/main/providers/deepseek');

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
const YESTERDAY = '2026-07-30';

function responseBody(dayData) {
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
            { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '100' },
            { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '200' },
            { type: 'RESPONSE_TOKEN', amount: '300' },
            { type: 'REQUEST', amount: '0' }
          ] },
          { model: 'deepseek-reasoner', usage: [
            { type: 'PROMPT_TOKEN', amount: '0' },
            { type: 'PROMPT_CACHE_HIT_TOKEN', amount: '10' },
            { type: 'PROMPT_CACHE_MISS_TOKEN', amount: '20' },
            { type: 'RESPONSE_TOKEN', amount: '30' },
            { type: 'REQUEST', amount: '0' }
          ] }
        ],
        days: dayData || [
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

function makeCtx(sessionToken) {
  return {
    store: {
      get: (key) => (key === 'providers.deepseek.sessionToken' ? sessionToken : null),
      set: () => {},
      delete: () => {}
    },
    logger: { log: () => {}, error: () => {} },
    getProxyUrl: () => null
  };
}

test('deepseek adapter fetchUsage persists daily tokens and backfills previous months', async () => {
  const body = responseBody();
  const mock = mockHttpsSequence([body]);
  const data = {};
  const ctx = {
    store: {
      get: (k) => (k === 'providers.deepseek.sessionToken' ? 'tok' : data[k]),
      set: (k, v) => { data[k] = v; }
    },
    getProxyUrl: () => null
  };
  try {
    await deepseekAdapter.fetchUsage(ctx, { month: 8, year: 2026 });
    // 当前月日数据持久化到 usageDaily(total/cached/models)
    const daily = data['usageDaily'];
    assert.equal(daily['deepseek:' + TODAY].total, 6);
    assert.equal(daily['deepseek:' + TODAY].cached, 1);
    assert.equal(daily['deepseek:' + YESTERDAY].total, 60);
    assert.equal(daily['deepseek:' + YESTERDAY].cached, 10);
    assert.ok(Array.isArray(daily['deepseek:' + TODAY].models));
    assert.equal(daily['deepseek:' + TODAY].models[0].model, 'deepseek-chat');
    // 回填:向前 6 个月各请求一次 amount,并记录已抓取标记
    const fetched = data['providers.deepseek.fetchedMonths'];
    ['2026-07', '2026-06', '2026-05', '2026-04', '2026-03', '2026-02'].forEach((mk) => {
      assert.ok(fetched.includes(mk), 'fetchedMonths 应含 ' + mk);
    });
    assert.ok(mock.paths().some((p) => p.includes('/api/v0/usage/amount?month=7&year=2026')));
  } finally {
    mock.restore();
  }
});

test('deepseek adapter fetchUsage skips months already marked fetched', async () => {
  const body = responseBody();
  const mock = mockHttpsSequence([body]);
  const data = {
    'providers.deepseek.fetchedMonths': ['2026-07', '2026-06', '2026-05', '2026-04', '2026-03', '2026-02']
  };
  const ctx = {
    store: {
      get: (k) => (k === 'providers.deepseek.sessionToken' ? 'tok' : data[k]),
      set: (k, v) => { data[k] = v; }
    },
    getProxyUrl: () => null
  };
  try {
    await deepseekAdapter.fetchUsage(ctx, { month: 8, year: 2026 });
    // 全部历史月份已标记 → 只有当月 cost+amount 两个请求,无回填请求
    assert.equal(mock.paths().length, 2);
  } finally {
    mock.restore();
  }
});

test('deepseek adapter fetchUsage normalizes legacy usage payload', async () => {
  const body = responseBody();
  const mock = mockHttpsSequence([body, body]);
  try {
    const adapter = await new UsageFetcher().fetchUsageWithFallback('token', 8, 2026);
    assert.equal(adapter.cost.aggregate.totalCost, 660);
    assert.equal(adapter.cost.aggregate.todayCost, 6);
    assert.equal(adapter.amount.aggregate.totalTokens, 660);
    assert.equal(adapter.amount.aggregate.todayTokens, 6);
    assert.equal(adapter.amount.aggregate.cacheHit, 110);
    assert.equal(adapter.amount.aggregate.cacheMiss, 220);
    assert.equal(adapter.cost.dailyData.length, 2);
    assert.equal(adapter.amount.dailyData.length, 2);
    assert.equal(adapter.fellBack, false);
    assert.equal(adapter.month, 8);
  } finally {
    mock.restore();
  }
});

test('deepseek adapter fetchUsage accepts a custom host', async () => {
  const mock = mockHttpsSequence([responseBody(), responseBody()]);
  try {
    const fetcher = new UsageFetcher('mock.deepseek.test');
    await fetcher.fetchUsageWithFallback('token', 8, 2026);
    assert.equal(mock.paths().length, 2);
    assert.ok(mock.paths()[0].includes('/api/v0/usage/cost?month=8&year=2026'));
  } finally {
    mock.restore();
  }
});

test('deepseek balance fetcher normalizes the balance payload', async () => {
  const original = https.request;
  https.request = function (options, callback) {
    const req = new EventEmitter();
    req.setTimeout = function () {};
    req.destroy = function () {};
    req.end = function () {
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      process.nextTick(function () {
        res.emit('data', JSON.stringify({
          is_available: true,
          balance_infos: [{
            currency: 'CNY',
            total_balance: '100.5',
            granted_balance: '50',
            topped_up_balance: '50.5'
          }]
        }));
        res.emit('end');
      });
    };
    return req;
  };
  try {
    const info = await fetchBalance('sk-test');
    assert.deepEqual(info, {
      available: true,
      currency: 'CNY',
      total: '100.5',
      granted: '50',
      toppedUp: '50.5'
    });
  } finally {
    https.request = original;
  }
});
