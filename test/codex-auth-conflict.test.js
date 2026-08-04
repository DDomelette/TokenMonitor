const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-codex-conflict-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function authDocument(accessToken = 'old-access', refreshToken = 'old-refresh') {
  return {
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: 'account-1',
      id_token: 'fixed-id-token'
    },
    last_refresh: '2026-08-04T00:00:00.000Z',
    preserved: { source: 'codex-cli' }
  };
}

function oauthResponse() {
  return {
    access_token: 'new-access',
    refresh_token: 'new-refresh'
  };
}

function jsonBytes(value) {
  return Buffer.from(JSON.stringify(value, null, 2));
}

function writeAuthFile(authPath, value, mode = 0o600) {
  const bytes = jsonBytes(value);
  fs.writeFileSync(authPath, bytes, { mode });
  if (process.platform !== 'win32') fs.chmodSync(authPath, mode);
  return bytes;
}

function tempFiles(dir, authPath) {
  const prefix = path.basename(authPath) + '.tmp-';
  return fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
}

function loadAuthWithDeferredResponse(t) {
  const authPath = require.resolve('../src/main/providers/codex/auth');
  const httpPath = require.resolve('../src/main/core/http');
  const http = require(httpPath);
  const originalPost = http.httpPostJson;
  let resolveResponse;
  let announceStarted;
  const started = new Promise((resolve) => { announceStarted = resolve; });

  http.httpPostJson = () => {
    announceStarted();
    return new Promise((resolve) => { resolveResponse = resolve; });
  };
  delete require.cache[authPath];
  const auth = require(authPath);

  t.after(() => {
    http.httpPostJson = originalPost;
    delete require.cache[authPath];
  });

  return {
    auth,
    started,
    resolve(value = oauthResponse()) {
      resolveResponse(structuredClone(value));
    }
  };
}

function loadAuthWithImmediateResponse(t, response = oauthResponse()) {
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

function replaceWithSameMetadata(authPath, value, originalStat) {
  const bytes = jsonBytes(value);
  assert.equal(bytes.length, originalStat.size, 'fixture must preserve file size');
  fs.writeFileSync(authPath, bytes);
  fs.utimesSync(authPath, originalStat.atime, originalStat.mtime);
  const after = fs.statSync(authPath);
  assert.equal(after.size, originalStat.size);
  assert.equal(after.mtimeMs, originalStat.mtimeMs);
  return bytes;
}

test('Codex refresh preserves a same-size same-mtime CLI update made during OAuth', async (t) => {
  const dir = tempDir(t);
  const authPath = path.join(dir, 'auth.json');
  writeAuthFile(authPath, authDocument());
  const originalStat = fs.statSync(authPath);
  const harness = loadAuthWithDeferredResponse(t);
  const staleAuth = harness.auth.readAuth(authPath);

  const refreshPromise = harness.auth.refreshAuth(
    { getProxyUrl: () => null },
    staleAuth
  );
  await harness.started;

  const cliDocument = authDocument('cli-access', 'cli-refresh');
  const cliBytes = replaceWithSameMetadata(authPath, cliDocument, originalStat);
  harness.resolve();
  const result = await refreshPromise;

  assert.ok(result);
  assert.equal(result.accessToken, 'cli-access');
  assert.equal(result.refreshToken, 'cli-refresh');
  assert.deepEqual(fs.readFileSync(authPath), cliBytes);
  assert.deepEqual(tempFiles(dir, authPath), []);
});

test('Codex refresh rechecks content after temp fsync and before rename', async (t) => {
  const dir = tempDir(t);
  const authPath = path.join(dir, 'auth.json');
  writeAuthFile(authPath, authDocument());
  const originalStat = fs.statSync(authPath);
  const cliDocument = authDocument('cli-access', 'cli-refresh');
  const cliBytes = jsonBytes(cliDocument);
  assert.equal(cliBytes.length, originalStat.size);
  const auth = loadAuthWithImmediateResponse(t);
  const staleAuth = auth.readAuth(authPath);
  const originalFsync = fs.fsyncSync;
  let injected = false;
  t.after(() => { fs.fsyncSync = originalFsync; });

  fs.fsyncSync = (fd) => {
    originalFsync(fd);
    if (!injected) {
      injected = true;
      replaceWithSameMetadata(authPath, cliDocument, originalStat);
    }
  };

  const result = await auth.refreshAuth(
    { getProxyUrl: () => null },
    staleAuth
  );

  fs.fsyncSync = originalFsync;
  assert.equal(injected, true);
  assert.ok(result);
  assert.equal(result.accessToken, 'cli-access');
  assert.equal(result.refreshToken, 'cli-refresh');
  assert.deepEqual(fs.readFileSync(authPath), cliBytes);
  assert.deepEqual(tempFiles(dir, authPath), []);
});

test('Codex refresh still writes rotated tokens when the source version is unchanged', async (t) => {
  const dir = tempDir(t);
  const authPath = path.join(dir, 'auth.json');
  writeAuthFile(authPath, authDocument());
  const auth = loadAuthWithImmediateResponse(t);

  const result = await auth.refreshAuth(
    { getProxyUrl: () => null },
    auth.readAuth(authPath)
  );

  assert.ok(result);
  assert.equal(result.accessToken, 'new-access');
  assert.equal(result.refreshToken, 'new-refresh');
  const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.equal(raw.tokens.access_token, 'new-access');
  assert.equal(raw.tokens.refresh_token, 'new-refresh');
  assert.deepEqual(raw.preserved, { source: 'codex-cli' });
  assert.deepEqual(tempFiles(dir, authPath), []);
});
