const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function recoveryEntries(userDataDir) {
  const root = path.join(userDataDir, 'recovery-backups');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort();
}

function pendingDirectory(userDataDir) {
  const entries = recoveryEntries(userDataDir).filter((name) => name.startsWith('.pending-'));
  assert.equal(entries.length, 1, `expected one pending recovery directory, got ${entries.join(', ')}`);
  return path.join(userDataDir, 'recovery-backups', entries[0]);
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

test('existing source bytes are staged before Store construction and discarded after success', (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery');
  const userDataDir = tempUserData(t);
  const key = 'ab'.repeat(32);
  const config = Buffer.from('encrypted-config-before-construction');
  fs.writeFileSync(path.join(userDataDir, '.key'), key, { mode: 0o600 });
  fs.writeFileSync(path.join(userDataDir, 'config.json'), config, { mode: 0o600 });

  let receivedOptions;
  class SuccessfulStore {
    constructor(options) {
      receivedOptions = options;
      const pending = pendingDirectory(userDataDir);
      assert.equal(fs.readFileSync(path.join(pending, '.key'), 'utf8'), key);
      assert.deepEqual(fs.readFileSync(path.join(pending, 'config.json')), config);
      const manifest = JSON.parse(fs.readFileSync(path.join(pending, 'recovery-manifest.json'), 'utf8'));
      assert.equal(manifest.version, 1);
      assert.match(manifest.fingerprint, /^[0-9a-f]{64}$/);
    }
  }

  const store = initializeStore({ StoreClass: SuccessfulStore, userDataDir, defaults: { ok: true } });

  assert.ok(store instanceof SuccessfulStore);
  assert.equal(receivedOptions.clearInvalidConfig, false);
  assert.equal(receivedOptions.cwd, userDataDir);
  assert.equal(receivedOptions.name, 'config');
  assert.equal(receivedOptions.encryptionKey, key);
  assert.deepEqual(recoveryEntries(userDataDir), []);
});

test('config failure finalizes exact pre-construction bytes and exposes only safe fields', (t) => {
  const { initializeStore, StoreStartupError } = require('../src/main/core/store-recovery');
  const userDataDir = tempUserData(t);
  const key = 'cd'.repeat(32);
  const config = Buffer.from('ciphertext-before-failure');
  const keyPath = path.join(userDataDir, '.key');
  const configPath = path.join(userDataDir, 'config.json');
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.writeFileSync(configPath, config, { mode: 0o600 });

  class FailingStore {
    constructor(options) {
      assert.equal(options.clearInvalidConfig, false);
      const pending = pendingDirectory(userDataDir);
      assert.deepEqual(fs.readFileSync(path.join(pending, 'config.json')), config);
      throw new SyntaxError('sk-secret-config-fragment');
    }
  }

  let startupError;
  assert.throws(
    () => initializeStore({ StoreClass: FailingStore, userDataDir, defaults: {} }),
    (error) => {
      startupError = error;
      assert.ok(error instanceof StoreStartupError);
      assert.equal(error.code, 'CONFIG_READ_FAILED');
      assert.equal(error.causeCode, 'SYNTAX_ERROR');
      assert.equal(error.backupStatus, 'complete');
      assert.ok(error.backupDir);
      assert.match(path.basename(error.backupDir), /^backup-[0-9a-f]{16}(?:-\d+)?$/);
      assert.doesNotMatch(error.message, /sk-secret-config-fragment/);
      assert.equal(fs.readFileSync(path.join(error.backupDir, '.key'), 'utf8'), key);
      assert.deepEqual(fs.readFileSync(path.join(error.backupDir, 'config.json')), config);
      return true;
    }
  );

  assert.ok(startupError);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), key);
  assert.deepEqual(fs.readFileSync(configPath), config);
  assert.equal(recoveryEntries(userDataDir).filter((name) => name.startsWith('.pending-')).length, 0);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(startupError.backupDir).mode & 0o777, 0o700);
    for (const name of ['.key', 'config.json', 'recovery-manifest.json']) {
      assert.equal(fs.statSync(path.join(startupError.backupDir, name)).mode & 0o777, 0o600);
    }
  }
});

test('repeated identical failure reuses one verified final backup', (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery');
  const userDataDir = tempUserData(t);
  fs.writeFileSync(path.join(userDataDir, '.key'), 'ef'.repeat(32), { mode: 0o600 });
  fs.writeFileSync(path.join(userDataDir, 'config.json'), 'same-ciphertext', { mode: 0o600 });

  class FailingStore {
    constructor() {
      throw new SyntaxError('same failure');
    }
  }

  const failures = [];
  for (let index = 0; index < 2; index += 1) {
    try {
      initializeStore({ StoreClass: FailingStore, userDataDir, defaults: {} });
    } catch (error) {
      failures.push(error);
    }
  }

  assert.equal(failures.length, 2);
  assert.equal(failures[0].backupDir, failures[1].backupDir);
  const finals = recoveryEntries(userDataDir).filter((name) => name.startsWith('backup-'));
  assert.deepEqual(finals, [path.basename(failures[0].backupDir)]);
  assert.equal(recoveryEntries(userDataDir).filter((name) => name.startsWith('.pending-')).length, 0);
});

test('a corrupt colliding backup directory is never overwritten', (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery');
  const userDataDir = tempUserData(t);
  fs.writeFileSync(path.join(userDataDir, '.key'), '12'.repeat(32), { mode: 0o600 });
  fs.writeFileSync(path.join(userDataDir, 'config.json'), 'collision-source', { mode: 0o600 });

  class FailingStore {
    constructor() {
      throw new SyntaxError('failure');
    }
  }

  let first;
  try {
    initializeStore({ StoreClass: FailingStore, userDataDir, defaults: {} });
  } catch (error) {
    first = error;
  }
  assert.ok(first && first.backupDir);
  fs.writeFileSync(path.join(first.backupDir, 'recovery-manifest.json'), '{"corrupt":true}', { mode: 0o600 });

  let second;
  try {
    initializeStore({ StoreClass: FailingStore, userDataDir, defaults: {} });
  } catch (error) {
    second = error;
  }

  assert.ok(second && second.backupDir);
  assert.notEqual(second.backupDir, first.backupDir);
  assert.equal(fs.readFileSync(path.join(first.backupDir, 'recovery-manifest.json'), 'utf8'), '{"corrupt":true}');
  assert.equal(JSON.parse(fs.readFileSync(path.join(second.backupDir, 'recovery-manifest.json'), 'utf8')).version, 1);
});

test('invalid existing key is mapped, backed up, and never reaches Store construction', (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery');
  const userDataDir = tempUserData(t);
  const invalidKey = 'damaged-key-material';
  const config = 'encrypted-config';
  fs.writeFileSync(path.join(userDataDir, '.key'), invalidKey, { mode: 0o600 });
  fs.writeFileSync(path.join(userDataDir, 'config.json'), config, { mode: 0o600 });
  let constructed = 0;

  assert.throws(
    () => initializeStore({
      StoreClass: class { constructor() { constructed += 1; } },
      userDataDir,
      defaults: {}
    }),
    (error) => {
      assert.equal(error.code, 'KEY_INVALID');
      assert.equal(error.backupStatus, 'complete');
      assert.equal(fs.readFileSync(path.join(error.backupDir, '.key'), 'utf8'), invalidKey);
      assert.equal(fs.readFileSync(path.join(error.backupDir, 'config.json'), 'utf8'), config);
      return true;
    }
  );

  assert.equal(constructed, 0);
  assert.equal(fs.readFileSync(path.join(userDataDir, '.key'), 'utf8'), invalidKey);
  assert.equal(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf8'), config);
});

test('existing config without a key is a recovery error and does not generate a replacement key', (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery');
  const userDataDir = tempUserData(t);
  const configPath = path.join(userDataDir, 'config.json');
  const keyPath = path.join(userDataDir, '.key');
  fs.writeFileSync(configPath, 'orphaned-encrypted-config', { mode: 0o600 });
  let constructed = 0;

  assert.throws(
    () => initializeStore({
      StoreClass: class { constructor() { constructed += 1; } },
      userDataDir,
      defaults: {}
    }),
    (error) => {
      assert.equal(error.code, 'KEY_MISSING_WITH_CONFIG');
      assert.equal(error.backupStatus, 'complete');
      assert.equal(
        fs.readFileSync(path.join(error.backupDir, 'config.json'), 'utf8'),
        'orphaned-encrypted-config'
      );
      return true;
    }
  );

  assert.equal(constructed, 0);
  assert.equal(fs.existsSync(keyPath), false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'orphaned-encrypted-config');
});

test('unreadable key creates only a partial safe backup and never writes a replacement key', (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery');
  const userDataDir = tempUserData(t);
  const keyPath = path.join(userDataDir, '.key');
  const configPath = path.join(userDataDir, 'config.json');
  fs.writeFileSync(keyPath, '34'.repeat(32), { mode: 0o600 });
  fs.writeFileSync(configPath, 'readable-config', { mode: 0o600 });
  let keyWriteCalls = 0;
  const fsImpl = proxyFs({
    readFileSync(filePath, ...args) {
      if (filePath === keyPath) {
        const error = new Error('sk-sensitive-permission-detail');
        error.code = 'EACCES';
        throw error;
      }
      return fs.readFileSync(filePath, ...args);
    },
    writeFileSync(filePath, ...args) {
      if (filePath === keyPath) keyWriteCalls += 1;
      return fs.writeFileSync(filePath, ...args);
    }
  });

  assert.throws(
    () => initializeStore({ StoreClass: class {}, userDataDir, defaults: {}, fsImpl }),
    (error) => {
      assert.equal(error.code, 'KEY_READ_FAILED');
      assert.equal(error.causeCode, 'EACCES');
      assert.equal(error.backupStatus, 'partial');
      assert.equal(fs.existsSync(path.join(error.backupDir, '.key')), false);
      assert.equal(fs.readFileSync(path.join(error.backupDir, 'config.json'), 'utf8'), 'readable-config');
      assert.doesNotMatch(error.message, /sk-sensitive/);
      return true;
    }
  );

  assert.equal(keyWriteCalls, 0);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'readable-config');
});

test('unreadable config stops before Store construction with a partial key backup', (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery');
  const userDataDir = tempUserData(t);
  const keyPath = path.join(userDataDir, '.key');
  const configPath = path.join(userDataDir, 'config.json');
  const key = '56'.repeat(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.writeFileSync(configPath, 'unreadable-config', { mode: 0o600 });
  let constructed = 0;
  const fsImpl = proxyFs({
    readFileSync(filePath, ...args) {
      if (filePath === configPath) {
        const error = new Error('private config error');
        error.code = 'EACCES';
        throw error;
      }
      return fs.readFileSync(filePath, ...args);
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
      assert.equal(error.code, 'CONFIG_READ_FAILED');
      assert.equal(error.causeCode, 'EACCES');
      assert.equal(error.backupStatus, 'partial');
      assert.equal(fs.readFileSync(path.join(error.backupDir, '.key'), 'utf8'), key);
      assert.equal(fs.existsSync(path.join(error.backupDir, 'config.json')), false);
      return true;
    }
  );

  assert.equal(constructed, 0);
});

test('backup staging failure blocks key and Store initialization', (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery');
  const userDataDir = tempUserData(t);
  const keyPath = path.join(userDataDir, '.key');
  const configPath = path.join(userDataDir, 'config.json');
  const recoveryRoot = path.join(userDataDir, 'recovery-backups');
  const key = '78'.repeat(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.writeFileSync(configPath, 'must-remain', { mode: 0o600 });
  let constructed = 0;
  let keyWrites = 0;
  const fsImpl = proxyFs({
    mkdirSync(dirPath, options) {
      if (dirPath === recoveryRoot) {
        const error = new Error('sk-backup-permission-detail');
        error.code = 'EACCES';
        throw error;
      }
      return fs.mkdirSync(dirPath, options);
    },
    writeFileSync(filePath, ...args) {
      if (filePath === keyPath) keyWrites += 1;
      return fs.writeFileSync(filePath, ...args);
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
      assert.equal(error.backupDir, null);
      assert.doesNotMatch(error.message, /sk-backup/);
      return true;
    }
  );

  assert.equal(constructed, 0);
  assert.equal(keyWrites, 0);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), key);
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'must-remain');
});

test('healthy first launch creates a key without creating a recovery directory', (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery');
  const userDataDir = tempUserData(t);
  let receivedOptions;

  class SuccessfulStore {
    constructor(options) {
      receivedOptions = options;
    }
  }

  const store = initializeStore({
    StoreClass: SuccessfulStore,
    userDataDir,
    defaults: { firstLaunch: true }
  });

  assert.ok(store instanceof SuccessfulStore);
  assert.match(receivedOptions.encryptionKey, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(path.join(userDataDir, '.key'), 'utf8'), receivedOptions.encryptionKey);
  assert.equal(fs.existsSync(path.join(userDataDir, 'recovery-backups')), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(userDataDir, '.key')).mode & 0o777, 0o600);
  }
});

test('a failure while copying staged source bytes fails closed and cleans the incomplete pending directory', (t) => {
  const { initializeStore } = require('../src/main/core/store-recovery');
  const userDataDir = tempUserData(t);
  const keyPath = path.join(userDataDir, '.key');
  const configPath = path.join(userDataDir, 'config.json');
  fs.writeFileSync(keyPath, '90'.repeat(32), { mode: 0o600 });
  fs.writeFileSync(configPath, 'preserve-this-config', { mode: 0o600 });
  let constructed = 0;
  const fsImpl = proxyFs({
    writeFileSync(filePath, ...args) {
      if (path.basename(filePath) === 'config.json' && filePath !== configPath) {
        const error = new Error('sk-copy-write-detail');
        error.code = 'ENOSPC';
        throw error;
      }
      return fs.writeFileSync(filePath, ...args);
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
      assert.equal(error.causeCode, 'ENOSPC');
      assert.doesNotMatch(error.message, /sk-copy/);
      return true;
    }
  );

  assert.equal(constructed, 0);
  assert.equal(fs.readFileSync(keyPath, 'utf8'), '90'.repeat(32));
  assert.equal(fs.readFileSync(configPath, 'utf8'), 'preserve-this-config');
  assert.equal(recoveryEntries(userDataDir).filter((name) => name.startsWith('.pending-')).length, 0);
});

test('recovery dialog and metadata expose only allow-listed startup fields', () => {
  const {
    buildStoreRecoveryDialog,
    safeStoreStartupMetadata,
    StoreStartupError
  } = require('../src/main/core/store-recovery');
  const error = new StoreStartupError('CONFIG_READ_FAILED', {
    causeCode: 'SYNTAX_ERROR',
    backupDir: path.join('/safe', 'recovery-backups', 'backup-abcdef0123456789'),
    backupStatus: 'complete',
    backupErrorCode: null
  });
  error.message = 'sk-api-key secret session raw exception';
  error.stack = 'stack with sk-api-key secret session';
  error.cause = new Error('refresh-token-secret');

  const metadata = safeStoreStartupMetadata(error);
  assert.deepEqual(metadata, {
    code: 'CONFIG_READ_FAILED',
    causeCode: 'SYNTAX_ERROR',
    backupStatus: 'complete',
    hasBackup: true,
    backupErrorCode: null
  });

  const recovery = buildStoreRecoveryDialog(error);
  assert.equal(recovery.backupDir, error.backupDir);
  assert.equal(recovery.openBackupButton, 0);
  assert.deepEqual(recovery.options.buttons, ['打开恢复副本', '退出']);
  assert.equal(recovery.options.defaultId, 0);
  assert.equal(recovery.options.cancelId, 1);
  const visible = JSON.stringify(recovery.options);
  assert.match(visible, /应用已停止启动/);
  assert.match(visible, /CONFIG_READ_FAILED/);
  assert.match(visible, /backup-abcdef0123456789/);
  assert.match(visible, /恢复副本/);
  assert.doesNotMatch(visible, /sk-api-key|refresh-token|raw exception|stack with|session raw/i);
});

test('partial or absent backups produce accurate safe dialog actions', () => {
  const {
    buildStoreRecoveryDialog,
    StoreStartupError
  } = require('../src/main/core/store-recovery');

  const partial = buildStoreRecoveryDialog(new StoreStartupError('KEY_READ_FAILED', {
    causeCode: 'EACCES',
    backupDir: '/safe/recovery-backups/backup-partial',
    backupStatus: 'partial',
    backupErrorCode: 'EXDEV'
  }));
  assert.match(partial.options.detail, /部分完成/);
  assert.match(partial.options.detail, /EACCES/);
  assert.match(partial.options.detail, /EXDEV/);
  assert.deepEqual(partial.options.buttons, ['打开恢复副本', '退出']);

  const none = buildStoreRecoveryDialog(Object.assign(new Error('unsafe secret'), {
    code: 'NOT_ALLOWED_$SECRET',
    causeCode: 'also unsafe',
    backupDir: null,
    backupStatus: 'mystery'
  }));
  assert.equal(none.backupDir, null);
  assert.equal(none.openBackupButton, null);
  assert.deepEqual(none.options.buttons, ['退出']);
  assert.equal(none.options.defaultId, 0);
  assert.equal(none.options.cancelId, 0);
  assert.match(none.options.detail, /STORE_STARTUP_FAILED/);
  assert.doesNotMatch(JSON.stringify(none.options), /unsafe secret|NOT_ALLOWED_\$SECRET|also unsafe/);
});
