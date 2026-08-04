const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadOrCreateEncryptionKey } = require('./encryption-key');

const MANIFEST_NAME = 'recovery-manifest.json';

const SAFE_MESSAGES = {
  KEY_INVALID: '检测到现有加密密钥格式异常。',
  KEY_MISSING_WITH_CONFIG: '检测到已有加密配置，但对应的 .key 文件缺失。',
  KEY_READ_FAILED: '无法读取现有加密密钥文件。',
  KEY_CREATE_FAILED: '首次启动时无法安全创建加密密钥文件。',
  CONFIG_READ_FAILED: '现有配置无法使用当前密钥解密、解析或读取。',
  BACKUP_FAILED: '无法在配置初始化前创建安全恢复副本。',
  STORE_STARTUP_FAILED: '无法安全加载应用配置。'
};

function safeCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(value)
    ? value
    : null;
}

function safeBackupStatus(value) {
  return ['none', 'complete', 'partial'].includes(value) ? value : 'none';
}

function safeStartupCode(value) {
  return value && SAFE_MESSAGES[value] ? value : 'STORE_STARTUP_FAILED';
}

function errorCode(error) {
  const direct = safeCode(error && error.code);
  if (direct) return direct;
  const name = error && typeof error.name === 'string'
    ? error.name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()
    : '';
  return safeCode(name) || 'UNKNOWN';
}

class StoreStartupError extends Error {
  constructor(code, details = {}) {
    const safeCategory = safeStartupCode(code);
    super(SAFE_MESSAGES[safeCategory]);
    this.name = 'StoreStartupError';
    this.code = safeCategory;
    this.causeCode = safeCode(details.causeCode);
    this.backupDir = typeof details.backupDir === 'string' && details.backupDir
      ? details.backupDir
      : null;
    this.backupStatus = safeBackupStatus(details.backupStatus);
    this.backupErrorCode = safeCode(details.backupErrorCode);
  }
}

function safeStoreStartupMetadata(error) {
  const code = safeStartupCode(error && error.code);
  const backupDir = error && typeof error.backupDir === 'string' && error.backupDir
    ? error.backupDir
    : null;
  return {
    code,
    causeCode: safeCode(error && error.causeCode),
    backupStatus: safeBackupStatus(error && error.backupStatus),
    hasBackup: Boolean(backupDir),
    backupErrorCode: safeCode(error && error.backupErrorCode)
  };
}

function buildStoreRecoveryDialog(error) {
  const metadata = safeStoreStartupMetadata(error);
  const backupDir = metadata.hasBackup ? error.backupDir : null;
  const details = [
    SAFE_MESSAGES[metadata.code],
    `错误类别：${metadata.code}`
  ];

  if (metadata.causeCode) {
    details.push(`系统错误类别：${metadata.causeCode}`);
  }

  if (backupDir) {
    details.push(`恢复副本：${backupDir}`);
    details.push(metadata.backupStatus === 'complete'
      ? '恢复副本状态：完整。原始密钥和配置文件仍保留在原位置。'
      : '恢复副本状态：部分完成。至少一个源文件无法读取，请先修复文件权限或磁盘问题。');
  } else {
    details.push('恢复副本状态：不可用。请先手动复制用户数据目录，再检查文件权限和磁盘状态。');
  }

  if (metadata.backupErrorCode) {
    details.push(`恢复副本处理错误：${metadata.backupErrorCode}`);
  }

  details.push('应用不会创建空配置替代现有数据。修复或恢复文件后，请重新启动 Token Monitor。');

  const buttons = backupDir ? ['打开恢复副本', '退出'] : ['退出'];
  return {
    backupDir,
    openBackupButton: backupDir ? 0 : null,
    options: {
      type: 'error',
      title: 'Token Monitor 配置保护',
      message: '应用已停止启动，以保护现有配置。',
      detail: details.join('\n\n'),
      buttons,
      defaultId: 0,
      cancelId: backupDir ? 1 : 0,
      noLink: true
    }
  };
}

function readSnapshotEntry(fsImpl, filePath, name) {
  try {
    return {
      name,
      state: 'data',
      data: Buffer.from(fsImpl.readFileSync(filePath)),
      causeCode: null
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { name, state: 'missing', data: null, causeCode: null };
    }
    return {
      name,
      state: 'unreadable',
      data: null,
      causeCode: safeCode(error && error.code) || 'UNKNOWN'
    };
  }
}

function captureRecoverySnapshot({ fsImpl = fs, keyPath, configPath }) {
  const entries = [
    readSnapshotEntry(fsImpl, keyPath, '.key'),
    readSnapshotEntry(fsImpl, configPath, 'config.json')
  ];
  const hash = crypto.createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.name);
    hash.update('\0');
    hash.update(entry.state);
    hash.update('\0');
    hash.update(entry.causeCode || '');
    hash.update('\0');
    if (entry.data) hash.update(entry.data);
    hash.update('\0');
  }
  return {
    entries,
    fingerprint: hash.digest('hex'),
    hasSourceMaterial: entries.some((entry) => entry.state !== 'missing')
  };
}

function manifestFor(snapshot, now) {
  return {
    version: 1,
    fingerprint: snapshot.fingerprint,
    createdAt: new Date(now()).toISOString(),
    complete: snapshot.entries.every((entry) => entry.state !== 'unreadable'),
    files: snapshot.entries.map((entry) => ({
      name: entry.name,
      state: entry.state,
      causeCode: entry.causeCode,
      bytes: entry.data ? entry.data.length : 0,
      sha256: entry.data
        ? crypto.createHash('sha256').update(entry.data).digest('hex')
        : null
    }))
  };
}

function pathExists(fsImpl, filePath) {
  try {
    fsImpl.statSync(filePath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function verifyBackupDirectory(fsImpl, backupDir, snapshot) {
  try {
    const manifest = JSON.parse(
      fsImpl.readFileSync(path.join(backupDir, MANIFEST_NAME), 'utf8')
    );
    if (
      !manifest
      || manifest.version !== 1
      || manifest.fingerprint !== snapshot.fingerprint
      || !Array.isArray(manifest.files)
    ) {
      return false;
    }
    for (const entry of snapshot.entries) {
      const recorded = manifest.files.find((file) => file && file.name === entry.name);
      if (!recorded || recorded.state !== entry.state || recorded.causeCode !== entry.causeCode) {
        return false;
      }
      if (entry.state !== 'data') {
        if (recorded.bytes !== 0 || recorded.sha256 !== null) return false;
        continue;
      }
      const copied = Buffer.from(fsImpl.readFileSync(path.join(backupDir, entry.name)));
      const copiedHash = crypto.createHash('sha256').update(copied).digest('hex');
      if (
        !copied.equals(entry.data)
        || recorded.bytes !== entry.data.length
        || recorded.sha256 !== copiedHash
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function stageRecoveryBackup({ fsImpl = fs, userDataDir, snapshot, now = Date.now }) {
  if (!snapshot.hasSourceMaterial) return null;
  const root = path.join(userDataDir, 'recovery-backups');
  fsImpl.mkdirSync(root, { recursive: true, mode: 0o700 });
  const prefix = snapshot.fingerprint.slice(0, 16);
  let suffix = 0;

  while (true) {
    const tail = suffix ? '-' + suffix : '';
    const finalDir = path.join(root, `backup-${prefix}${tail}`);
    if (pathExists(fsImpl, finalDir)) {
      if (verifyBackupDirectory(fsImpl, finalDir, snapshot)) {
        return { kind: 'final', backupDir: finalDir, snapshot };
      }
      suffix += 1;
      continue;
    }

    const backupDir = path.join(root, `.pending-${prefix}${tail}`);
    if (pathExists(fsImpl, backupDir)) {
      if (verifyBackupDirectory(fsImpl, backupDir, snapshot)) {
        return { kind: 'pending', backupDir, snapshot };
      }
      suffix += 1;
      continue;
    }

    try {
      fsImpl.mkdirSync(backupDir, { mode: 0o700 });
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        suffix += 1;
        continue;
      }
      throw error;
    }

    try {
      for (const entry of snapshot.entries) {
        if (entry.state !== 'data') continue;
        fsImpl.writeFileSync(path.join(backupDir, entry.name), entry.data, {
          mode: 0o600,
          flag: 'wx'
        });
      }
      fsImpl.writeFileSync(
        path.join(backupDir, MANIFEST_NAME),
        JSON.stringify(manifestFor(snapshot, now), null, 2),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      );
      return { kind: 'pending', backupDir, snapshot };
    } catch (error) {
      try {
        fsImpl.rmSync(backupDir, { recursive: true, force: true });
      } catch {}
      throw error;
    }
  }
}

function discardRecoveryBackup(handle, fsImpl = fs) {
  if (!handle || handle.kind !== 'pending') return;
  fsImpl.rmSync(handle.backupDir, { recursive: true, force: true });
}

function finalizeRecoveryBackup(handle, fsImpl = fs) {
  if (!handle) return { backupDir: null, backupStatus: 'none' };
  const status = handle.snapshot.entries.some((entry) => entry.state === 'unreadable')
    ? 'partial'
    : 'complete';
  if (handle.kind === 'final') {
    return { backupDir: handle.backupDir, backupStatus: status };
  }

  const root = path.dirname(handle.backupDir);
  const prefix = handle.snapshot.fingerprint.slice(0, 16);
  let suffix = 0;
  while (true) {
    const finalDir = path.join(root, `backup-${prefix}${suffix ? '-' + suffix : ''}`);
    let finalExists;
    try {
      finalExists = pathExists(fsImpl, finalDir);
    } catch (error) {
      return {
        backupDir: handle.backupDir,
        backupStatus: 'partial',
        backupErrorCode: errorCode(error)
      };
    }
    if (finalExists) {
      if (verifyBackupDirectory(fsImpl, finalDir, handle.snapshot)) {
        fsImpl.rmSync(handle.backupDir, { recursive: true, force: true });
        return { backupDir: finalDir, backupStatus: status };
      }
      suffix += 1;
      continue;
    }
    try {
      fsImpl.renameSync(handle.backupDir, finalDir);
      return { backupDir: finalDir, backupStatus: status };
    } catch (error) {
      if (error && ['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
        suffix += 1;
        continue;
      }
      return {
        backupDir: handle.backupDir,
        backupStatus: 'partial',
        backupErrorCode: errorCode(error)
      };
    }
  }
}

function startupError(code, cause, backup) {
  return new StoreStartupError(code, {
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

  const keyPath = path.join(userDataDir, '.key');
  const configPath = path.join(userDataDir, 'config.json');
  const snapshot = captureRecoverySnapshot({ fsImpl, keyPath, configPath });
  let backup;
  try {
    backup = stageRecoveryBackup({ fsImpl, userDataDir, snapshot, now });
  } catch (cause) {
    throw startupError('BACKUP_FAILED', cause, null);
  }

  const keyEntry = snapshotEntry(snapshot, '.key');
  const configEntry = snapshotEntry(snapshot, 'config.json');
  if (keyEntry.state === 'missing' && configEntry.state !== 'missing') {
    const finalized = finalizeRecoveryBackup(backup, fsImpl);
    throw startupError('KEY_MISSING_WITH_CONFIG', null, finalized);
  }

  let encryptionKey;
  try {
    encryptionKey = loadOrCreateEncryptionKey(keyPath, {
      fs: fsImpl,
      crypto: cryptoImpl
    });
  } catch (cause) {
    const finalized = finalizeRecoveryBackup(backup, fsImpl);
    throw startupError(keyStartupCode(cause), underlyingCause(cause), finalized);
  }

  if (configEntry.state === 'unreadable') {
    const finalized = finalizeRecoveryBackup(backup, fsImpl);
    throw startupError(
      'CONFIG_READ_FAILED',
      { code: configEntry.causeCode },
      finalized
    );
  }

  try {
    const store = new StoreClass({
      defaults,
      cwd: userDataDir,
      name: 'config',
      encryptionKey,
      clearInvalidConfig: false
    });
    discardRecoveryBackup(backup, fsImpl);
    return store;
  } catch (cause) {
    const finalized = finalizeRecoveryBackup(backup, fsImpl);
    throw startupError('CONFIG_READ_FAILED', cause, finalized);
  }
}

module.exports = {
  StoreStartupError,
  buildStoreRecoveryDialog,
  captureRecoverySnapshot,
  discardRecoveryBackup,
  finalizeRecoveryBackup,
  initializeStore,
  safeStoreStartupMetadata,
  stageRecoveryBackup,
  verifyBackupDirectory
};
