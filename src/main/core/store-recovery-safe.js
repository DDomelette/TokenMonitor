const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadOrCreateEncryptionKey } = require('./encryption-key');
const recovery = require('./store-recovery');

function safeCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(value)
    ? value
    : null;
}

function errorCode(error) {
  const direct = safeCode(error && error.code);
  if (direct) return direct;
  const name = error && typeof error.name === 'string'
    ? error.name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()
    : '';
  return safeCode(name) || 'UNKNOWN';
}

function unsafeBackupPathError() {
  const error = new Error('Recovery backup path is not a private directory tree.');
  error.code = 'UNSAFE_BACKUP_PATH';
  return error;
}

function lstatOrNull(fsImpl, target) {
  try {
    return fsImpl.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertSafeRecoveryTree(fsImpl, userDataDir) {
  const root = path.join(userDataDir, 'recovery-backups');
  const rootStat = lstatOrNull(fsImpl, root);
  if (!rootStat) return;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw unsafeBackupPathError();
  }

  for (const name of fsImpl.readdirSync(root)) {
    const backupDir = path.join(root, name);
    const backupStat = fsImpl.lstatSync(backupDir);
    if (backupStat.isSymbolicLink() || !backupStat.isDirectory()) {
      throw unsafeBackupPathError();
    }
    for (const childName of fsImpl.readdirSync(backupDir)) {
      const childStat = fsImpl.lstatSync(path.join(backupDir, childName));
      if (childStat.isSymbolicLink() || !childStat.isFile()) {
        throw unsafeBackupPathError();
      }
    }
  }
}

function backupStatus(handle) {
  if (!handle) return 'none';
  return handle.snapshot.entries.some((entry) => entry.state === 'unreadable')
    ? 'partial'
    : 'complete';
}

function findVerifiedFinal(handle, fsImpl) {
  if (!handle) return null;
  const root = path.dirname(handle.backupDir);
  const prefix = handle.snapshot.fingerprint.slice(0, 16);
  const candidates = fsImpl.readdirSync(root)
    .filter((name) => name === `backup-${prefix}` || name.startsWith(`backup-${prefix}-`))
    .sort();
  for (const name of candidates) {
    const finalDir = path.join(root, name);
    const stat = fsImpl.lstatSync(finalDir);
    if (
      !stat.isSymbolicLink()
      && stat.isDirectory()
      && recovery.verifyBackupDirectory(fsImpl, finalDir, handle.snapshot)
    ) {
      return finalDir;
    }
  }
  return null;
}

function finalizeRecoveryBackup(handle, fsImpl = fs) {
  try {
    return recovery.finalizeRecoveryBackup(handle, fsImpl);
  } catch (error) {
    let verifiedFinal = null;
    try {
      verifiedFinal = findVerifiedFinal(handle, fsImpl);
    } catch {}
    return {
      backupDir: verifiedFinal || (handle && handle.backupDir) || null,
      backupStatus: verifiedFinal ? backupStatus(handle) : (handle ? 'partial' : 'none'),
      backupErrorCode: errorCode(error)
    };
  }
}

function startupError(code, cause, backup) {
  return new recovery.StoreStartupError(code, {
    causeCode: cause ? errorCode(cause) : null,
    backupDir: backup && backup.backupDir,
    backupStatus: backup && backup.backupStatus,
    backupErrorCode: backup && backup.backupErrorCode
  });
}

function snapshotEntry(snapshot, name) {
  return snapshot.entries.find((entry) => entry.name === name);
}

function keyStartupCode(error) {
  switch (error && error.code) {
    case 'ENCRYPTION_KEY_INVALID':
      return 'KEY_INVALID';
    case 'ENCRYPTION_KEY_READ_FAILED':
      return 'KEY_READ_FAILED';
    case 'ENCRYPTION_KEY_CREATE_FAILED':
      return 'KEY_CREATE_FAILED';
    default:
      return 'STORE_STARTUP_FAILED';
  }
}

function underlyingCause(error) {
  return error && error.cause ? error.cause : error;
}

function initializeStore({
  StoreClass,
  userDataDir,
  defaults,
  fsImpl = fs,
  cryptoImpl = crypto,
  now = Date.now
}) {
  if (typeof StoreClass !== 'function') throw new TypeError('StoreClass must be a constructor');
  if (!userDataDir) throw new TypeError('userDataDir is required');

  try {
    assertSafeRecoveryTree(fsImpl, userDataDir);
  } catch (cause) {
    throw startupError('BACKUP_FAILED', cause, null);
  }

  const keyPath = path.join(userDataDir, '.key');
  const configPath = path.join(userDataDir, 'config.json');
  const snapshot = recovery.captureRecoverySnapshot({ fsImpl, keyPath, configPath });
  let backup;
  try {
    backup = recovery.stageRecoveryBackup({ fsImpl, userDataDir, snapshot, now });
    assertSafeRecoveryTree(fsImpl, userDataDir);
  } catch (cause) {
    throw startupError('BACKUP_FAILED', cause, null);
  }

  const keyEntry = snapshotEntry(snapshot, '.key');
  const configEntry = snapshotEntry(snapshot, 'config.json');
  if (keyEntry.state === 'missing' && configEntry.state !== 'missing') {
    throw startupError(
      'KEY_MISSING_WITH_CONFIG',
      null,
      finalizeRecoveryBackup(backup, fsImpl)
    );
  }

  let encryptionKey;
  try {
    encryptionKey = loadOrCreateEncryptionKey(keyPath, {
      fs: fsImpl,
      crypto: cryptoImpl
    });
  } catch (cause) {
    throw startupError(
      keyStartupCode(cause),
      underlyingCause(cause),
      finalizeRecoveryBackup(backup, fsImpl)
    );
  }

  if (configEntry.state === 'unreadable') {
    throw startupError(
      'CONFIG_READ_FAILED',
      { code: configEntry.causeCode },
      finalizeRecoveryBackup(backup, fsImpl)
    );
  }

  let store;
  try {
    store = new StoreClass({
      defaults,
      cwd: userDataDir,
      name: 'config',
      encryptionKey,
      clearInvalidConfig: false
    });
  } catch (cause) {
    throw startupError(
      'CONFIG_READ_FAILED',
      cause,
      finalizeRecoveryBackup(backup, fsImpl)
    );
  }

  try {
    recovery.discardRecoveryBackup(backup, fsImpl);
  } catch (cause) {
    throw startupError(
      'BACKUP_FAILED',
      cause,
      finalizeRecoveryBackup(backup, fsImpl)
    );
  }
  return store;
}

module.exports = {
  ...recovery,
  assertSafeRecoveryTree,
  finalizeRecoveryBackup,
  initializeStore
};
