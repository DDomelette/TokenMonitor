const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 注: kimi /usages 真实抓取被过期 access_token 阻断(401 REASON_INVALID_AUTH_TOKEN,见 Task 0 Spike),
// 本 fixture 依据计划"已验证的事实"文档化结构合成,断言值为计划规定的周/5h 窗口语义。
const fixture = require('./fixtures/kimi-usages.json');
const { normalizeKimiUsage } = require('../src/main/providers/kimi/quota');
const { readCred, isExpired } = require('../src/main/providers/kimi/auth');

test('normalizeKimiUsage maps weekly + 5h windows from the fixture', () => {
  const quota = normalizeKimiUsage(fixture);
  assert.equal(quota.provider, 'kimi');
  assert.equal(quota.billingMode, 'subscription');

  const weekly = quota.windows.find((w) => w.kind === 'weekly');
  assert.ok(weekly);
  assert.deepEqual([weekly.used, weekly.limit, weekly.remaining], [57, 100, 43]);
  assert.equal(new Date(weekly.resetsAt).toISOString(), '2026-08-06T18:08:07.095Z');

  const fiveH = quota.windows.find((w) => w.kind === '5h');
  assert.ok(fiveH);
  assert.deepEqual([fiveH.used, fiveH.limit, fiveH.remaining], [65, 100, 35]);
  assert.ok(quota.fetchedAt > 0);
});

test('normalizeKimiUsage tolerates missing limits array', () => {
  const quota = normalizeKimiUsage({ usage: { limit: 100, used: 10, remaining: 90, resetTime: '2026-08-06T18:08:07.095Z' } });
  assert.equal(quota.windows.length, 1);
  assert.equal(quota.windows[0].kind, 'weekly');
});

function tempCredFile(data) {
  const p = path.join(os.tmpdir(), 'dsm-kimi-cred-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(p, JSON.stringify(data));
  return p;
}

test('readCred reads the kimi credentials structure', () => {
  const p = tempCredFile({
    access_token: 'acc', refresh_token: 'ref', expires_at: 1785674374, scope: 'kimi-code'
  });
  try {
    const cred = readCred(p);
    assert.equal(cred.accessToken, 'acc');
    assert.equal(cred.refreshToken, 'ref');
    assert.equal(cred.expiresAt, 1785674374 * 1000);
    assert.equal(cred.scope, 'kimi-code');
  } finally {
    fs.unlinkSync(p);
  }
});

test('readCred returns null for missing file', () => {
  assert.equal(readCred(path.join(os.tmpdir(), 'no-such-cred-' + Date.now() + '.json')), null);
});

test('isExpired flags near-expiry credentials', () => {
  assert.equal(isExpired({ expiresAt: Date.now() + 60 * 1000 }), true);
  assert.equal(isExpired({ expiresAt: Date.now() + 10 * 60 * 1000 }), false);
  assert.equal(isExpired({ expiresAt: null }), false);
});

test('kimi credential access is read-only (CLI owns refresh; proactive refresh raced the CLI)', () => {
  const quotaSource = fs.readFileSync(path.resolve(__dirname, '../src/main/providers/kimi/quota.js'), 'utf8');
  const authSource = fs.readFileSync(path.resolve(__dirname, '../src/main/providers/kimi/auth.js'), 'utf8');
  assert.match(quotaSource, /readCred\(\)/);
  assert.doesNotMatch(quotaSource, /ensureFresh|refreshCred/);
  // refresh_token 一次性轮换:任何主动刷新成功都会作废 CLI 内存中的旧 RT
  assert.doesNotMatch(authSource, /refreshCred|writeCredentialAtomic|oauth\/token/);
});
