const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadSessionState() {
  const modulePath = require.resolve('../src/main/core/session-state');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('session state transitions valid to expired to valid without trusting a stale token', () => {
  const {
    expireSession,
    getSessionSnapshot,
    restoreSession
  } = loadSessionState();
  const runtime = {
    sessionToken: null,
    sessionStatus: 'missing',
    sessionError: null
  };

  restoreSession(runtime, 'valid-token');
  assert.deepEqual(getSessionSnapshot(runtime), {
    status: 'valid',
    loggedIn: true,
    error: null
  });

  expireSession(runtime, '会话已过期，请重新登录');
  assert.equal(runtime.sessionToken, null);
  assert.deepEqual(getSessionSnapshot(runtime), {
    status: 'expired',
    loggedIn: false,
    error: '会话已过期，请重新登录'
  });

  restoreSession(runtime, 'replacement-token');
  assert.deepEqual(getSessionSnapshot(runtime), {
    status: 'valid',
    loggedIn: true,
    error: null
  });
});

test('only an explicit valid status can report logged in', () => {
  const { getSessionSnapshot } = loadSessionState();

  assert.deepEqual(getSessionSnapshot({
    sessionToken: 'stale-token',
    sessionStatus: 'expired',
    sessionError: '会话已过期，请重新登录'
  }), {
    status: 'expired',
    loggedIn: false,
    error: '会话已过期，请重新登录'
  });
});

test('tray login labels distinguish missing, expired, and valid states', () => {
  const { getTraySessionLabel } = loadSessionState();

  assert.equal(getTraySessionLabel({ status: 'missing', loggedIn: false, error: null }), '登录平台获取用量');
  assert.equal(getTraySessionLabel({ status: 'expired', loggedIn: false, error: 'expired' }), '会话已过期，重新登录');
  assert.equal(getTraySessionLabel({ status: 'valid', loggedIn: true, error: null }), '重新登录平台');
});

test('main process integrates the session state boundary for expiry, delegated restoration, snapshots, and tray text', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../src/main/index.js'), 'utf8');
  const ipc = fs.readFileSync(path.resolve(__dirname, '../src/main/ipc.js'), 'utf8');
  const startup = fs.readFileSync(
    path.resolve(__dirname, '../src/main/core/provider-startup.js'),
    'utf8'
  );

  assert.match(main, /require\('\.\/core\/session-state'\)/);
  assert.match(main, /expireSession\(runtime, '会话已过期，请重新登录'\)/);
  assert.match(main, /store\.delete\('providers\.deepseek\.sessionToken'\)/);
  assert.match(main, /restoreSession\(runtime, token\)/);
  assert.equal(main.includes('initializeMainRenderer({'), true);
  assert.equal(startup.includes("deps.store.get('providers.deepseek.sessionToken')"), true);
  assert.equal(startup.includes('deps.restoreSession(deps.runtime, storedSessionToken)'), true);
  assert.match(main, /getTraySessionLabel\(getSessionSnapshot\(runtime\)\)/);
  assert.match(ipc, /getSessionSnapshot\(deps\.runtime\)/);
});

test('settings page prioritizes the explicit expiry error whenever loggedIn is false', () => {
  const settings = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-window.js'),
    'utf8'
  );

  assert.match(
    settings,
    /text\.textContent = loggedIn[\s\S]*?\(\(sessionState && sessionState\.error\) \|\| '未登录或会话已过期'\)/
  );
});
