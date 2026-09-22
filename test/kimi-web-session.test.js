const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
  decodeJwtExpMs,
  readWebTokens,
  writeWebTokens,
  clearWebTokens,
  ensureFreshWebToken,
  monthlyWindowFromStats,
  fetchSubscriptionStats
} = require('../src/main/providers/kimi/web-session');
const { fetchQuota, quotaStateFromWebStats } = require('../src/main/providers/kimi/quota');
const kimiProvider = require('../src/main/providers/kimi/index.js');

function makeStore(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  return {
    get(k) {
      return k.split('.').reduce((o, p) => (o && o[p] !== undefined ? o[p] : undefined), data);
    },
    set(k, v) {
      const parts = k.split('.');
      let node = data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = v;
    },
    delete(k) {
      const parts = k.split('.');
      let node = data;
      for (let i = 0; i < parts.length - 1; i++) {
        node = node && node[parts[i]];
        if (!node) return;
      }
      delete node[parts[parts.length - 1]];
    },
    _data: data
  };
}

function fakeJwt(expSec) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64({ alg: 'ES256', typ: 'JWT' }) + '.' + b64({ exp: expSec }) + '.sig';
}

const silentLogger = { log() {}, error() {} };
const AUTH_ERROR_RE = /unauthoriz|401|403|登录|expired|invalid token/i; // 与 scheduler.isAuthError 同规则

function webLinkedStore() {
  const store = makeStore();
  writeWebTokens(store, {
    accessToken: 'web-token',
    refreshToken: 'rt',
    expiresAt: Date.now() + 10 * 60 * 1000
  });
  return store;
}

test('decodeJwtExpMs reads exp claim and tolerates garbage', () => {
  assert.equal(decodeJwtExpMs(fakeJwt(1789000000)), 1789000000 * 1000);
  assert.equal(decodeJwtExpMs('not-a-jwt'), null);
  assert.equal(decodeJwtExpMs(null), null);
});

test('web token store round-trip and clear', () => {
  const store = makeStore();
  assert.equal(readWebTokens(store), null);
  writeWebTokens(store, { accessToken: 'a', refreshToken: 'r', expiresAt: 123 });
  assert.deepEqual(readWebTokens(store), { accessToken: 'a', refreshToken: 'r', expiresAt: 123 });
  assert.equal(store.get('providers.kimi.webLinked'), true);
  clearWebTokens(store);
  assert.equal(readWebTokens(store), null);
  assert.equal(store.get('providers.kimi.webLinked'), false);
});

test('ensureFreshWebToken returns stored token without HTTP when fresh', async () => {
  const store = webLinkedStore();
  let httpCalls = 0;
  const token = await ensureFreshWebToken(store, {
    httpPostJson: async () => { httpCalls++; throw new Error('must not be called'); },
    logger: silentLogger
  });
  assert.equal(token, 'web-token');
  assert.equal(httpCalls, 0);
});

test('ensureFreshWebToken refreshes expiring token and writes back rotation', async () => {
  const store = makeStore();
  writeWebTokens(store, {
    accessToken: 'old-token',
    refreshToken: 'rt-old',
    expiresAt: Date.now() + 10 * 1000
  });
  const newAccess = fakeJwt(Math.floor(Date.now() / 1000) + 900);
  const calls = [];
  const token = await ensureFreshWebToken(store, {
    httpPostJson: async (url, body) => {
      calls.push({ url, body });
      return { accessToken: newAccess, refreshToken: 'rt-new' };
    },
    logger: silentLogger
  });
  assert.equal(token, newAccess);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken');
  assert.deepEqual(calls[0].body, { refreshToken: 'rt-old' });
  const stored = readWebTokens(store);
  assert.equal(stored.accessToken, newAccess);
  assert.equal(stored.refreshToken, 'rt-new');
  assert.ok(stored.expiresAt > Date.now() + 800 * 1000);
});

test('ensureFreshWebToken clears credentials when refresh is rejected (401)', async () => {
  const store = makeStore();
  writeWebTokens(store, { accessToken: 'old', refreshToken: 'rt-dead', expiresAt: Date.now() - 1000 });
  const token = await ensureFreshWebToken(store, {
    httpPostJson: async () => { throw new Error('Unauthorized: bad refresh token (HTTP 401)'); },
    logger: silentLogger
  });
  assert.equal(token, null);
  assert.equal(readWebTokens(store), null);
  assert.equal(store.get('providers.kimi.webLinked'), false);
});

test('ensureFreshWebToken keeps credentials on transient network failure', async () => {
  const store = makeStore();
  writeWebTokens(store, { accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() - 1000 });
  const token = await ensureFreshWebToken(store, {
    httpPostJson: async () => { throw new Error('connect ETIMEDOUT'); },
    logger: silentLogger
  });
  assert.equal(token, null);
  assert.ok(readWebTokens(store), 'credentials must survive transient failures');
});

test('monthlyWindowFromStats maps amountUsedRatio to a percent window', () => {
  const w = monthlyWindowFromStats({
    subscriptionBalance: { amountUsedRatio: 0.1472, expireTime: '2026-10-02T00:00:00Z' }
  });
  assert.equal(w.kind, 'monthly');
  assert.ok(Math.abs(w.used - 14.72) < 1e-9);
  assert.equal(w.limit, 100);
  assert.ok(Math.abs(w.remaining - 85.28) < 1e-9);
  assert.equal(w.resetsAt, Date.parse('2026-10-02T00:00:00Z'));
});

test('monthlyWindowFromStats clamps ratio and rejects missing balance', () => {
  const over = monthlyWindowFromStats({ subscriptionBalance: { amountUsedRatio: 1.4 } });
  assert.equal(over.used, 100);
  assert.equal(over.remaining, 0);
  assert.equal(monthlyWindowFromStats({}), null);
  assert.equal(monthlyWindowFromStats(null), null);
  assert.equal(monthlyWindowFromStats({ subscriptionBalance: {} }), null);
});

test('quotaStateFromWebStats builds weekly/5h/monthly windows in order', () => {
  const state = quotaStateFromWebStats({
    ratelimitCode5h: { ratio: 0.1015, enabled: true, resetTime: '2026-09-11T07:20:36.779570659Z' },
    ratelimitCode7d: { ratio: 0.0359, enabled: true, resetTime: '2026-09-13T17:20:36.779570659Z' },
    subscriptionBalance: { amountUsedRatio: 0.1995, expireTime: '2026-10-02T00:00:00Z' }
  }, 'Allegretto');
  assert.deepEqual(state.windows.map((w) => w.kind), ['weekly', '5h', 'monthly']);
  const [weekly, fiveH, monthly] = state.windows;
  assert.ok(Math.abs(weekly.used - 3.59) < 1e-9);
  assert.ok(Math.abs(fiveH.used - 10.15) < 1e-9);
  assert.ok(Math.abs(monthly.used - 19.95) < 1e-9);
  // 纳秒精度的 resetTime 可被 Date.parse 截断解析
  assert.equal(fiveH.resetsAt, Date.parse('2026-09-11T07:20:36.779570659Z'));
  assert.equal(state.planName, 'Allegretto');
});

test('quotaStateFromWebStats treats omitted ratio as zero (proto3 JSON omission)', () => {
  const state = quotaStateFromWebStats({
    ratelimitCode5h: { enabled: true, resetTime: '2026-09-11T07:20:36.779570659Z' },
    ratelimitCode7d: { ratio: 0.0359, enabled: true, resetTime: '2026-09-13T17:20:36.779570659Z' },
    subscriptionBalance: { amountUsedRatio: 0.2, expireTime: '2026-10-02T00:00:00Z' }
  });
  const fiveH = state.windows.find((w) => w.kind === '5h');
  assert.equal(fiveH.used, 0);
  assert.equal(fiveH.remaining, 100);
});

test('quotaStateFromWebStats skips disabled windows and rejects empty stats', () => {
  const state = quotaStateFromWebStats({
    ratelimitCode5h: { enabled: false },
    ratelimitCode7d: { ratio: 0.1, enabled: true },
    subscriptionBalance: { amountUsedRatio: 0.2 }
  });
  assert.deepEqual(state.windows.map((w) => w.kind), ['weekly', 'monthly']);
  assert.equal(quotaStateFromWebStats(null), null);
  assert.equal(quotaStateFromWebStats({}), null);
});

test('fetchSubscriptionStats posts GetSubscriptionStats with the web bearer token', async () => {
  const store = webLinkedStore();
  const calls = [];
  const stats = await fetchSubscriptionStats({
    store,
    logger: silentLogger,
    getProxyUrl: () => null,
    httpPostJson: async (url, body, headers) => {
      calls.push({ url, body, headers });
      return { subscriptionBalance: { amountUsedRatio: 0.5, expireTime: '2026-10-02T00:00:00Z' } };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats');
  assert.deepEqual(calls[0].body, {});
  assert.equal(calls[0].headers.Authorization, 'Bearer web-token');
  assert.equal(stats.subscriptionBalance.amountUsedRatio, 0.5);
});

test('fetchSubscriptionStats returns null when web session was never captured', async () => {
  const stats = await fetchSubscriptionStats({ store: makeStore(), logger: silentLogger, getProxyUrl: () => null });
  assert.equal(stats, null);
});

test('fetchQuota with web session builds all three windows without touching the CLI', async () => {
  const store = webLinkedStore();
  store.set('providers.kimi.lastQuota', { quota: { planName: 'Allegretto' }, fetchedAt: 1 });
  let cliCalls = 0;
  const state = await fetchQuota({
    store,
    logger: silentLogger,
    getProxyUrl: () => null,
    httpGet: async () => { cliCalls++; throw new Error('CLI must not be called'); },
    httpPostJson: async () => ({
      ratelimitCode5h: { ratio: 0.4, enabled: true, resetTime: '2026-09-11T07:20:36Z' },
      ratelimitCode7d: { ratio: 0.2, enabled: true, resetTime: '2026-09-13T17:20:36Z' },
      subscriptionBalance: { amountUsedRatio: 0.1, expireTime: '2026-10-02T00:00:00Z' }
    })
  });
  assert.equal(cliCalls, 0);
  assert.deepEqual(state.windows.map((w) => w.kind), ['weekly', '5h', 'monthly']);
  assert.equal(state.windows[0].used, 20);
  assert.equal(state.windows[1].used, 40);
  assert.equal(state.windows[2].used, 10);
  // 网页响应无套餐名,沿用上轮
  assert.equal(state.planName, 'Allegretto');
});

test('fetchQuota web failure throws a non-auth error (stale data, never an expired card)', async () => {
  const store = webLinkedStore();
  await assert.rejects(
    fetchQuota({
      store,
      logger: silentLogger,
      getProxyUrl: () => null,
      httpGet: async () => { throw new Error('CLI must not be called'); },
      httpPostJson: async () => { throw new Error('HTTP 502 Bad Gateway'); }
    }),
    (err) => {
      assert.doesNotMatch(err.message, AUTH_ERROR_RE);
      return true;
    }
  );
});

test('kimi authStatus is ok with a web session regardless of CLI credentials', () => {
  const store = webLinkedStore();
  assert.equal(kimiProvider.authStatus({ store }), 'ok');
});

test('kimi:web-login is wired through preload whitelist and main ipc handler', () => {
  const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
  assert.match(preload, /'kimi:web-login'/);
  const ipcJs = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
  const handler = ipcJs.match(/ipcMain\.on\('kimi:web-login'[\s\S]*?\n  \}\);/);
  assert.ok(handler, 'ipc.js must handle kimi:web-login');
  assert.match(handler[0], /captureWebSession/);
  assert.match(handler[0], /writeWebTokens/);
  const settingsJs = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');
  assert.match(settingsJs, /kimi:web-login/);
  assert.match(settingsJs, /kimiWebLoginBtn/);
});
