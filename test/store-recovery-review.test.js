const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-recovery-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function proxyFs(overrides) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

test('a symlinked recovery root is rejected before any backup or Store write', { skip: process.platform === 'win32' }, (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery-safe');
  const userDataDir = tempUserData(t);
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-recovery-external-'));
  t.after(() => fs.rmSync(externalDir, { recursive: true, force: true }));
  const keyPath = path.join(userDataDir, '.key');
  const configPath = path.join(userDataDir, 'config.json');
  const recoveryRoot = path.join(userDataDir, 'recovery-backups');
  const key = 'a1'.repeat(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.writeFileSync(configPath, 'protected-config', { mode: 0o600 });
  fs.symlinkSync(externalDir, recoveryRoot, 'dir');
  let constructed = 0;

  assert.throws(
    () => initializeStore({
      StoreClass: class { constructor() { constructed += 1; } },
      userDataDir,
      defaults: {}
    }),
    (error) => {
      assert.equal(error.code, 'BACKUP_FAILED');
      assert.equal(error.causeCode, 'UNSAFE_BACKUP_PATH');
      assert.equal(error.backupDir, null);
      return true;
    }
  );

  assert.equal(constructed, 0);
  assert.deepEqual(fs.readdirSync(externalDir), []);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), key);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'protected-config');
});

test('cleanup failure after successful Store construction is a backup failure', (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery-safe');
  const userDataDir = tempUserData(t);
  const keyPath = path.join(userDataDir, '.key');
  const configPath = path.join(userDataDir, 'config.json');
  const key = 'b2'.repeat(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.writeFileSync(configPath, 'valid-encrypted-config', { mode: 0o600 });
  let constructed = 0;
  const fsImpl = proxyFs({
    rmSync(target, options) {
      if (path.basename(target).startsWith('.pending-')) {
        const error = new Error('secret cleanup detail');
        error.code = 'EACCES';
        throw error;
      }
      return fs.rmSync(target, options);
    }
  });

  assert.throws(
    () => initializeStore({
      StoreClass: class { constructor() { constructed += 1; } },
      userDataDir,
      defaults: {},
      fsImpl
    }),
    (error) => {
      assert.equal(error.code, 'BACKUP_FAILED');
      assert.equal(error.causeCode, 'EACCES');
      assert.equal(error.backupStatus, 'complete');
      assert.ok(error.backupDir);
      assert.doesNotMatch(error.message, /secret cleanup/);
      return true;
    }
  );

  assert.equal(constructed, 1);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), key);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'valid-encrypted-config');
});

test('duplicate pending cleanup failures are reduced to safe backup metadata', (t) => {
  const {
    captureRecoverySnapshot,
    finalizeRecoveryBackup,
    stageRecoveryBackup
  } = require('../src/main/core/store-recovery-safe');
  const userDataDir = tempUserData(t);
  const keyPath = path.join(userDataDir, '.key');
  const configPath = path.join(userDataDir, 'config.json');
  fs.writeFileSync(keyPath, 'c3'.repeat(32), { mode: 0o600 });
  fs.writeFileSync(configPath, 'duplicate-backup-source', { mode: 0o600 });
  const snapshot = captureRecoverySnapshot({ fsImpl: fs, keyPath, configPath });
  const first = stageRecoveryBackup({ fsImpl: fs, userDataDir, snapshot });
  const finalized = finalizeRecoveryBackup(first, fs);
  const duplicatePending = path.join(
    path.dirname(finalized.backupDir),
    `.pending-${snapshot.fingerprint.slice(0, 16)}-duplicate`
  );
  fs.cpSync(finalized.backupDir, duplicatePending, { recursive: true });
  const fsImpl = proxyFs({
    rmSync(target, options) {
      if (target === duplicatePending) {
        const error = new Error('secret duplicate cleanup detail');
        error.code = 'EACCES';
        throw error;
      }
      return fs.rmSync(target, options);
    }
  });

  const result = finalizeRecoveryBackup({
    kind: 'pending',
    backupDir: duplicatePending,
    snapshot
  }, fsImpl);

  assert.equal(result.backupDir, finalized.backupDir);
  assert.equal(result.backupStatus, 'complete');
  assert.equal(result.backupErrorCode, 'EACCES');
});

test('production store and startup modules use the hardened recovery boundary', () => {
  const storeSource = fs.readFileSync(path.resolve(__dirname, '../src/main/store.js'), 'utf8');
  const startupSource = fs.readFileSync(
    path.resolve(__dirname, '../src/main/core/startup-recovery.js'),
    'utf8'
  );
  assert.match(storeSource, /require\('\.\/core\/store-recovery-safe'\)/);
  assert.match(startupSource, /require\('\.\/store-recovery-safe'\)/);
});

test('store startup has one canonical recovery implementation and tests exercise that production path', () => {
  const coreDir = path.resolve(__dirname, '../src/main/core');
  const recoveryFiles = fs.readdirSync(coreDir)
    .filter((name) => /^store-recovery(?:-[a-z-]+)?\.js$/.test(name))
    .sort();
  const sources = recoveryFiles.map((name) => ({
    name,
    source: fs.readFileSync(path.join(coreDir, name), 'utf8')
  }));
  const initializeOwners = sources
    .filter(({ source }) => /function\s+initializeStore\s*\(/.test(source))
    .map(({ name }) => name);
  const keyHelperOwners = sources
    .filter(({ source }) => /require\('\.\/encryption-key'\)/.test(source))
    .map(({ name }) => name);

  assert.deepEqual(initializeOwners, ['store-recovery.js']);
  assert.deepEqual(keyHelperOwners, ['store-recovery.js']);

  const storeSource = fs.readFileSync(path.resolve(__dirname, '../src/main/store.js'), 'utf8');
  const startupSource = fs.readFileSync(
    path.resolve(__dirname, '../src/main/core/startup-recovery.js'),
    'utf8'
  );
  const behaviorTests = fs.readFileSync(
    path.resolve(__dirname, './store-recovery.test.js'),
    'utf8'
  );

  assert.match(storeSource, /require\('\.\/core\/store-recovery'\)/);
  assert.match(startupSource, /require\('\.\/store-recovery'\)/);
  assert.match(behaviorTests, /require\('\.\.\/src\/main\/core\/store-recovery'\)/);
  assert.doesNotMatch(storeSource + startupSource + behaviorTests, /store-recovery-safe/);
});
