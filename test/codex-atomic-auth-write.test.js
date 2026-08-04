const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-codex-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function originalAuth() {
  return {
    OPENAI_API_KEY: null,
    tokens: {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      account_id: 'account-1',
      id_token: 'old-id-token'
    },
    last_refresh: '2026-08-04T00:00:00.000Z',
    preserved: {
      cli: 'codex',
      nested: true
    }
  };
}

function refreshedTokens() {
  return {
    access_token: 'new-access',
    refresh_token: 'new-refresh'
  };
}

function loadAuthWithRefreshResponse(t, response = refreshedTokens()) {
  const authPath = require.resolve('../src/main/providers/codex/auth');
  const httpPath = require.resolve('../src/main/core/http');
  const http = require(httpPath);
  const originalPost = http.httpPostJson;
  http.httpPostJson = async () => structuredClone(response);
  delete require.cache[authPath];
  const auth = require(authPath);

  t.after(() => {
    http.httpPostJson = originalPost;
    delete require.cache[authPath];
  });
  return auth;
}

function tempFiles(dir, authPath) {
  const prefix = path.basename(authPath) + '.tmp-';
  return fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
}

function writeOriginal(authPath, mode = 0o640) {
  const bytes = Buffer.from(JSON.stringify(originalAuth(), null, 2));
  fs.writeFileSync(authPath, bytes, { mode });
  if (process.platform !== 'win32') fs.chmodSync(authPath, mode);
  return bytes;
}

test('Codex refresh atomically preserves unknown fields and POSIX metadata', {
  skip: process.platform === 'win32'
}, async (t) => {
  const dir = tempDir(t);
  const authPath = path.join(dir, 'auth.json');
  writeOriginal(authPath, 0o640);
  const before = fs.statSync(authPath);
  const auth = loadAuthWithRefreshResponse(t);

  const refreshed = await auth.refreshAuth(
    { getProxyUrl: () => null },
    auth.readAuth(authPath)
  );

  assert.ok(refreshed);
  const after = fs.statSync(authPath);
  assert.equal(after.mode & 0o777, 0o640);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.deepEqual(raw.preserved, { cli: 'codex', nested: true });
  assert.equal(raw.tokens.account_id, 'account-1');
  assert.equal(raw.tokens.id_token, 'old-id-token');
  assert.equal(raw.tokens.access_token, 'new-access');
  assert.equal(raw.tokens.refresh_token, 'new-refresh');
  assert.deepEqual(tempFiles(dir, authPath), []);
});

test('Codex refresh leaves original bytes untouched when temp-file fsync fails', async (t) => {
  const dir = tempDir(t);
  const authPath = path.join(dir, 'auth.json');
  const originalBytes = writeOriginal(authPath, 0o600);
  const auth = loadAuthWithRefreshResponse(t);
  const originalFsync = fs.fsyncSync;
  t.after(() => { fs.fsyncSync = originalFsync; });
  fs.fsyncSync = () => {
    const error = new Error('simulated fsync interruption');
    error.code = 'EIO';
    throw error;
  };

  const refreshed = await auth.refreshAuth(
    { getProxyUrl: () => null },
    auth.readAuth(authPath)
  );

  fs.fsyncSync = originalFsync;
  assert.equal(refreshed, null);
  assert.deepEqual(fs.readFileSync(authPath), originalBytes);
  assert.deepEqual(tempFiles(dir, authPath), []);
});

test('Codex refresh leaves original bytes untouched and cleans temp on rename failure', async (t) => {
  const dir = tempDir(t);
  const authPath = path.join(dir, 'auth.json');
  const originalBytes = writeOriginal(authPath, 0o600);
  const auth = loadAuthWithRefreshResponse(t);
  const originalRename = fs.renameSync;
  t.after(() => { fs.renameSync = originalRename; });
  fs.renameSync = (source, target) => {
    if (target === authPath) {
      const error = new Error('simulated rename interruption');
      error.code = 'EACCES';
      throw error;
    }
    return originalRename(source, target);
  };

  const refreshed = await auth.refreshAuth(
    { getProxyUrl: () => null },
    auth.readAuth(authPath)
  );

  fs.renameSync = originalRename;
  assert.equal(refreshed, null);
  assert.deepEqual(fs.readFileSync(authPath), originalBytes);
  assert.deepEqual(tempFiles(dir, authPath), []);
});
