const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadApi() {
  try {
    return { api: require('../src/main/core/encryption-key') };
  } catch (error) {
    return { error };
  }
}

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenmonitor-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('missing key is created once with a valid value and restrictive mode', (t) => {
  const loaded = loadApi();
  assert.equal(loaded.error, undefined, `module should load: ${loaded.error && loaded.error.message}`);
  const { loadOrCreateEncryptionKey } = loaded.api;
  assert.equal(typeof loadOrCreateEncryptionKey, 'function');

  const root = makeTempDir(t);
  const keyPath = path.join(root, 'nested-user-data', '.key');
  const created = loadOrCreateEncryptionKey(keyPath);

  assert.match(created, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), created);
  assert.equal(loadOrCreateEncryptionKey(keyPath), created);

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  }
});

test('invalid existing key is rejected without changing the file or exposing its contents', (t) => {
  const { loadOrCreateEncryptionKey } = require('../src/main/core/encryption-key');
  const root = makeTempDir(t);
  const keyPath = path.join(root, '.key');
  const invalid = 'truncated-secret-material';
  fs.writeFileSync(keyPath, invalid, { mode: 0o600 });

  let error;
  try {
    loadOrCreateEncryptionKey(keyPath);
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, 'invalid key should be rejected');
  assert.equal(error.code, 'ENCRYPTION_KEY_INVALID');
  assert.doesNotMatch(error.message, /truncated|secret|material/i);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), invalid);
});

test('non-ENOENT read failures abort without creating or overwriting a key', (t) => {
  const { loadOrCreateEncryptionKey } = require('../src/main/core/encryption-key');
  const root = makeTempDir(t);
  const keyPath = path.join(root, '.key');
  const accessError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  let mkdirCalls = 0;
  let writeCalls = 0;
  const fsStub = {
    readFileSync() {
      throw accessError;
    },
    mkdirSync() {
      mkdirCalls += 1;
    },
    writeFileSync() {
      writeCalls += 1;
    }
  };

  let error;
  try {
    loadOrCreateEncryptionKey(keyPath, { fs: fsStub });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, 'read failure should abort initialization');
  assert.equal(error.code, 'ENCRYPTION_KEY_READ_FAILED');
  assert.equal(error.cause, accessError);
  assert.equal(mkdirCalls, 0);
  assert.equal(writeCalls, 0);
  assert.equal(fs.existsSync(keyPath), false);
});

test('key creation uses an exclusive write and accepts a valid race winner', () => {
  const { loadOrCreateEncryptionKey } = require('../src/main/core/encryption-key');
  const keyPath = path.join('/virtual-user-data', '.key');
  const winningKey = 'ab'.repeat(32);
  const enoent = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const exists = Object.assign(new Error('created concurrently'), { code: 'EEXIST' });
  let reads = 0;
  let writeOptions;
  const fsStub = {
    readFileSync() {
      reads += 1;
      if (reads === 1) throw enoent;
      return winningKey;
    },
    mkdirSync() {},
    writeFileSync(_path, _value, options) {
      writeOptions = options;
      throw exists;
    }
  };
  const cryptoStub = {
    randomBytes() {
      return Buffer.alloc(32, 0xcd);
    }
  };

  const result = loadOrCreateEncryptionKey(keyPath, {
    fs: fsStub,
    crypto: cryptoStub
  });

  assert.equal(result, winningKey);
  assert.equal(reads, 2);
  assert.equal(writeOptions.flag, 'wx');
  assert.equal(writeOptions.mode, 0o600);
});

test('store initialization delegates key handling to the hardened helper', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/store.js'),
    'utf8'
  );

  assert.match(
    source,
    /const\s*\{\s*loadOrCreateEncryptionKey\s*\}\s*=\s*require\('\.\/core\/encryption-key'\)/
  );
  assert.match(source, /return loadOrCreateEncryptionKey\(keyPath\)/);
  assert.doesNotMatch(source, /crypto\.randomBytes|fs\.writeFileSync\(keyPath/);
});
