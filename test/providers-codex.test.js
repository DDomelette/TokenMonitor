const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const fixture = require('./fixtures/codex-wham-usage.json');
const { normalizeWhamUsage } = require('../src/main/providers/codex/quota');
const { readAuth, ensureFresh, tokenExpiryMs } = require('../src/main/providers/codex/auth');

test('normalizeWhamUsage maps the synthetic fixture into QuotaState', () => {
  const quota = normalizeWhamUsage(fixture);
  assert.equal(quota.provider, 'codex');
  assert.equal(quota.billingMode, 'subscription');
  assert.equal(quota.planName, 'pro');

  const weekly = quota.windows.find((w) => w.kind === 'weekly');
  assert.ok(weekly, 'weekly window must exist');
  assert.equal(weekly.used, 37);
  assert.equal(weekly.limit, 100);
  assert.equal(weekly.remaining, 63);
  assert.equal(weekly.resetsAt, fixture.rate_limit.primary_window.reset_at * 1000);
  assert.ok(weekly.resetsAt > 0);

  // secondary_window:null 不产生窗口;additional_rate_limits 合并进 windows
  assert.ok(quota.windows.length >= 2);

  // additional_rate_limits 的限额名称必须保留,否则与主周窗口(同为 weekly)无法区分
  const spark = quota.windows.find((w) => w.name === 'GPT-5.3-Codex-Spark');
  assert.ok(spark, 'additional rate limit must keep its limit_name');
  assert.equal(spark.kind, 'weekly');

  // credits.has_credits=false → balance 为 null
  assert.equal(quota.balance, null);
  assert.ok(quota.fetchedAt > 0);
});

test('used_percent=44 means 44 used, 56 remaining (semantic anchor)', () => {
  const anchored = JSON.parse(JSON.stringify(fixture));
  anchored.rate_limit.primary_window.used_percent = 44;
  const quota = normalizeWhamUsage(anchored);
  const weekly = quota.windows.find((w) => w.kind === 'weekly' && w.name === null);
  assert.equal(weekly.used, 44);
  assert.equal(weekly.remaining, 56);
});

test('normalizeWhamUsage maps credits into balance when has_credits', () => {
  const withCredits = Object.assign({}, fixture, {
    credits: { has_credits: true, balance: '12.5', unlimited: false }
  });
  const quota = normalizeWhamUsage(withCredits);
  assert.equal(quota.balance.total, 12.5);
  assert.equal(quota.balance.currency, 'USD');
});

function makeJwt(exp) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return header + '.' + payload + '.sig';
}

function tempAuthFile(data) {
  const p = path.join(os.tmpdir(), 'dsm-codex-auth-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

test('readAuth reads the codex auth.json structure', () => {
  const p = tempAuthFile({
    auth_mode: 'chatgpt',
    tokens: { id_token: 'id', access_token: 'acc', refresh_token: 'ref', account_id: 'acct' },
    last_refresh: '2026-08-01T00:00:00Z'
  });
  try {
    const auth = readAuth(p);
    assert.equal(auth.accessToken, 'acc');
    assert.equal(auth.accountId, 'acct');
    assert.equal(auth.refreshToken, 'ref');
    assert.equal(auth.lastRefresh, '2026-08-01T00:00:00Z');
  } finally {
    fs.unlinkSync(p);
  }
});

test('readAuth returns null for missing/corrupt file', () => {
  assert.equal(readAuth(path.join(os.tmpdir(), 'no-such-auth-' + Date.now() + '.json')), null);
});

test('tokenExpiryMs decodes the JWT exp claim', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  assert.equal(tokenExpiryMs(makeJwt(exp)), exp * 1000);
  assert.equal(tokenExpiryMs('not-a-jwt'), null);
});

test('ensureFresh skips refresh while the token is still fresh', async () => {
  const p = tempAuthFile({
    tokens: { access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'ref', account_id: 'a' }
  });
  try {
    const original = https.request;
    let called = false;
    https.request = function () { called = true; throw new Error('should not be called'); };
    try {
      const auth = await ensureFresh({ getProxyUrl: () => null }, p);
      assert.equal(called, false);
      assert.equal(auth.accessToken.includes('.'), true);
    } finally {
      https.request = original;
    }
  } finally {
    fs.unlinkSync(p);
  }
});

test('ensureFresh refreshes and writes back when the token is expired', async () => {
  const p = tempAuthFile({
    tokens: { access_token: makeJwt(Math.floor(Date.now() / 1000) - 3600), refresh_token: 'ref-token', account_id: 'a' }
  });
  const original = https.request;
  https.request = function (options, callback) {
    assert.equal(options.method, 'POST');
    const req = new EventEmitter();
    req.setTimeout = function () {};
    req.destroy = function () {};
    req.write = function () {};
    req.end = function () {
      const res = new EventEmitter();
      res.statusCode = 200;
      callback(res);
      process.nextTick(function () {
        res.emit('data', JSON.stringify({ access_token: makeJwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'new-rt' }));
        res.emit('end');
      });
    };
    return req;
  };
  try {
    const auth = await ensureFresh({ getProxyUrl: () => null }, p);
    assert.ok(auth.accessToken.includes('.'));
    const persisted = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(persisted.tokens.refresh_token, 'new-rt');
    assert.ok(persisted.last_refresh);
  } finally {
    https.request = original;
    fs.unlinkSync(p);
  }
});
