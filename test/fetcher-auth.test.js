const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const { UsageFetcher } = require('../src/main/providers/deepseek/usage');
const { fetchBalance } = require('../src/main/providers/deepseek/balance');

function mockHttpsResponse(statusCode, body) {
  const original = https.request;
  https.request = function (options, callback) {
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
  return function restore() {
    https.request = original;
  };
}

test('fetcher rejects with an unauthorized error on HTTP 401', async () => {
  const restore = mockHttpsResponse(401, '<html>Unauthorized</html>');
  try {
    await assert.rejects(
      new UsageFetcher().fetchUsageCost('expired-token', 7, 2026),
      /unauthoriz|401/i
    );
  } finally {
    restore();
  }
});

test('fetcher rejects with an unauthorized error on HTTP 403', async () => {
  const restore = mockHttpsResponse(403, '{"error":"forbidden"}');
  try {
    await assert.rejects(
      new UsageFetcher().fetchUsageCost('expired-token', 7, 2026),
      /unauthoriz|403|forbidden/i
    );
  } finally {
    restore();
  }
});

test('balance rejects instead of resolving null on API error responses', async () => {
  const restore = mockHttpsResponse(401, '{"error":{"message":"Invalid API key"}}');
  try {
    await assert.rejects(fetchBalance('sk-bad-key'));
  } finally {
    restore();
  }
});

test('balance still resolves parsed info on a valid response', async () => {
  const body = JSON.stringify({
    is_available: true,
    balance_infos: [{
      currency: 'CNY',
      total_balance: '10.00',
      granted_balance: '5.00',
      topped_up_balance: '5.00'
    }]
  });
  const restore = mockHttpsResponse(200, body);
  try {
    const info = await fetchBalance('sk-good-key');
    assert.equal(info.currency, 'CNY');
    assert.equal(info.total, '10.00');
  } finally {
    restore();
  }
});
