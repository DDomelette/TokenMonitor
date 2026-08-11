const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const TIMEOUT_MS = 3000;

function definition(id, title, guideId, run) {
  return { id, group: 'Storage', title, guideId, phase: 'local', timeoutMs: TIMEOUT_MS, run };
}

function createStorageChecks(dependencies = {}) {
  const fsApi = dependencies.fs || fs;
  const cryptoApi = dependencies.crypto || crypto;
  const pathApi = dependencies.path || path;
  const userDataDir = dependencies.userDataDir;
  const store = dependencies.store;
  const validateEncryptionKey = dependencies.validateEncryptionKey;
  const normalizeStoredProxyValue = dependencies.normalizeStoredProxyValue;
  return [
    definition('storage.user-data-access', 'User data directory access', 'storage-user-data', () => {
      try {
        fsApi.accessSync(userDataDir, fsApi.constants.R_OK | fsApi.constants.W_OK);
        return { status: 'pass', summary: 'User data directory is readable and writable' };
      } catch (_) {
        return { status: 'fail', summary: 'User data directory is unavailable', errorCode: 'USER_DATA_UNAVAILABLE' };
      }
    }),
    definition('storage.store-initialized', 'Encrypted store initialization', 'storage-config', () => {
      try {
        if (!store || typeof store.get !== 'function') throw Object.assign(new Error('missing Store'), { code: 'STORE_NOT_INITIALIZED' });
        store.get('data.historyDays');
        return { status: 'pass', summary: 'Initialized Store can read settings' };
      } catch (_) {
        return { status: 'fail', summary: 'Initialized Store is unavailable', errorCode: 'STORE_NOT_INITIALIZED' };
      }
    }),
    definition('storage.config-readable', 'Encrypted config readability', 'storage-config', () => {
      try {
        fsApi.readFileSync(pathApi.join(userDataDir, 'config.json'));
        return { status: 'pass', summary: 'Encrypted config bytes are readable' };
      } catch (_) {
        return { status: 'fail', summary: 'Encrypted config is unreadable', errorCode: 'CONFIG_UNREADABLE' };
      }
    }),
    definition('storage.temp-write', 'Temporary file write', 'storage-user-data', () => {
      const name = '.diagnostics-' + cryptoApi.randomBytes(12).toString('hex') + '.tmp';
      const target = pathApi.join(userDataDir, name);
      let fd;
      let owned = false;
      try {
        fd = fsApi.openSync(target, 'wx', 0o600);
        owned = true;
        fsApi.writeSync(fd, Buffer.from('ok'));
        fsApi.fsyncSync(fd);
        return { status: 'pass', summary: 'User data directory can safely create and remove temporary files' };
      } finally {
        try {
          if (fd !== undefined) fsApi.closeSync(fd);
        } finally {
          if (owned) fsApi.rmSync(target, { force: true });
        }
      }
    }),
    definition('storage.encryption-state', 'Encryption key state', 'storage-config', () => {
      try {
        if (typeof validateEncryptionKey !== 'function') throw new Error('missing validator');
        validateEncryptionKey(fsApi.readFileSync(pathApi.join(userDataDir, '.key'), 'utf8'));
        return { status: 'pass', summary: 'Encryption key is valid', metadata: { keyValid: true } };
      } catch (_) {
        return { status: 'fail', summary: 'Encryption key is invalid', errorCode: 'ENCRYPTION_KEY_INVALID', metadata: { keyValid: false } };
      }
    }),
    definition('storage.settings-schema', 'Stored settings validation', 'storage-config', () => {
      try {
        if (!store || typeof store.get !== 'function' || typeof normalizeStoredProxyValue !== 'function') {
          throw new Error('missing dependencies');
        }
        normalizeStoredProxyValue(store.get('providers.proxyUrl'));
        const historyDays = store.get('data.historyDays');
        if (!Number.isInteger(historyDays) || historyDays <= 0) throw new Error('invalid history days');
        return {
          status: 'pass',
          summary: 'Stored settings are valid',
          metadata: { proxyValid: true, historyDaysValid: true }
        };
      } catch (_) {
        return {
          status: 'fail',
          summary: 'Stored settings are invalid',
          errorCode: 'SETTINGS_INVALID',
          metadata: { proxyValid: false, historyDaysValid: false }
        };
      }
    })
  ];
}

module.exports = { createStorageChecks };
