const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-kimi-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function originalCredential() {
  return {
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_at: Math.floor(Date.now() / 1000) - 30,
    expires_in: 900,
    scope: 'openid',
    token_type: 'Bearer'
  };
}

function refreshedCredential() {
  return {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_in: 900,
    scope: 'openid profile',
    token_type: 'Bearer'
  };
}

function loadAuthWithRefreshResponse(t, response = refreshedCredential()) {
  const authPath = require.resolve('../src/main/providers/kimi/auth');
  const httpPath = require.resolve('../src/main/core/http');
  const http = require(httpPath);
  const originalPost = http.httpPostForm;
  http.httpPostForm = async () => structuredClone(response);
  delete require.cache[authPath];
  const auth = require(authPath);

  t.after(() => {
    http.httpPostForm = originalPost;
    delete require.cache[authPath];
  });
  return auth;
}

function tempFiles(dir, credPath) {
  const prefix = path.basename(credPath) + '.tmp-';
  return fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
}

test('Kimi refresh preserves the existing credential mode and owner', {
  skip: process.platform === 'win32'
}, async (t) => {
  const dir = tempDir(t);
  const credPath = path.join(dir, 'kimi-code.json');
  fs.writeFileSync(credPath, JSON.stringify(originalCredential()), { mode: 0o640 });
  fs.chmodSync(credPath, 0o640);
  const before = fs.statSync(credPath);
  const auth = loadAuthWithRefreshResponse(t);

  const refreshed = await auth.refreshCred(
    { getProxyUrl: () => null },
    auth.readCred(credPath)
  );

  assert.ok(refreshed);
  const after = fs.statSync(credPath);
  assert.equal(after.mode & 0o777, 0o640);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal(refreshed.accessToken, 'new-access');
  assert.equal(refreshed.refreshToken, 'new-refresh');
  assert.deepEqual(tempFiles(dir, credPath), []);
});

test('Kimi refresh creates a missing credential file with mode 0600', {
  skip: process.platform === 'win32'
}, async (t) => {
  const dir = tempDir(t);
  const credPath = path.join(dir, 'kimi-code.json');
  const auth = loadAuthWithRefreshResponse(t);

  const refreshed = await auth.refreshCred(
    { getProxyUrl: () => null },
    {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() - 30_000,
      scope: 'openid',
      credPath
    }
  );

  assert.ok(refreshed);
  assert.equal(fs.statSync(credPath).mode & 0o777, 0o600);
  const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  assert.equal(raw.access_token, 'new-access');
  assert.equal(raw.refresh_token, 'new-refresh');
  assert.deepEqual(tempFiles(dir, credPath), []);
});

test('Kimi refresh removes its temporary file when atomic replacement fails', {
  skip: process.platform === 'win32'
}, async (t) => {
  const dir = tempDir(t);
  const credPath = path.join(dir, 'kimi-code.json');
  const originalRaw = JSON.stringify(originalCredential(), null, 2);
  fs.writeFileSync(credPath, originalRaw, { mode: 0o600 });
  fs.chmodSync(credPath, 0o600);
  const auth = loadAuthWithRefreshResponse(t);
  const originalRename = fs.renameSync;
  t.after(() => { fs.renameSync = originalRename; });
  fs.renameSync = (source, target) => {
    if (target === credPath) {
      const error = new Error('simulated rename failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalRename(source, target);
  };

  const refreshed = await auth.refreshCred(
    { getProxyUrl: () => null },
    auth.readCred(credPath)
  );

  fs.renameSync = originalRename;
  assert.equal(refreshed, null);
  assert.equal(fs.readFileSync(credPath, 'utf8'), originalRaw);
  assert.equal(fs.statSync(credPath).mode & 0o777, 0o600);
  assert.deepEqual(tempFiles(dir, credPath), []);
});

test('Kimi refresh verifies and repairs the target mode after rename', {
  skip: process.platform === 'win32'
}, async (t) => {
  const dir = tempDir(t);
  const credPath = path.join(dir, 'kimi-code.json');
  fs.writeFileSync(credPath, JSON.stringify(originalCredential()), { mode: 0o600 });
  fs.chmodSync(credPath, 0o600);
  const auth = loadAuthWithRefreshResponse(t);
  const originalRename = fs.renameSync;
  t.after(() => { fs.renameSync = originalRename; });
  fs.renameSync = (source, target) => {
    const result = originalRename(source, target);
    if (target === credPath) fs.chmodSync(target, 0o666);
    return result;
  };

  const refreshed = await auth.refreshCred(
    { getProxyUrl: () => null },
    auth.readCred(credPath)
  );

  fs.renameSync = originalRename;
  assert.ok(refreshed);
  assert.equal(fs.statSync(credPath).mode & 0o777, 0o600);
  assert.deepEqual(tempFiles(dir, credPath), []);
});
