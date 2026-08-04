const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_PATTERN = /^[0-9a-f]{64}$/i;

class EncryptionKeyError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'EncryptionKeyError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function validateEncryptionKey(raw) {
  const key = String(raw).trim();
  if (!KEY_PATTERN.test(key)) {
    throw new EncryptionKeyError(
      'ENCRYPTION_KEY_INVALID',
      'Existing encryption key is invalid; refusing to replace it.'
    );
  }
  return key;
}

function systemErrorCode(error) {
  return error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
}

function readEncryptionKey(keyPath, fsApi, allowMissing) {
  try {
    return validateEncryptionKey(fsApi.readFileSync(keyPath, 'utf8'));
  } catch (error) {
    if (error instanceof EncryptionKeyError) throw error;
    if (allowMissing && error && error.code === 'ENOENT') return null;
    throw new EncryptionKeyError(
      'ENCRYPTION_KEY_READ_FAILED',
      `Unable to read existing encryption key (${systemErrorCode(error)}).`,
      error
    );
  }
}

function loadOrCreateEncryptionKey(keyPath, dependencies = {}) {
  const fsApi = dependencies.fs || fs;
  const cryptoApi = dependencies.crypto || crypto;
  const existing = readEncryptionKey(keyPath, fsApi, true);
  if (existing !== null) return existing;

  try {
    fsApi.mkdirSync(path.dirname(keyPath), { recursive: true });
    const key = cryptoApi.randomBytes(32).toString('hex');
    fsApi.writeFileSync(keyPath, key, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    return key;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      return readEncryptionKey(keyPath, fsApi, false);
    }
    throw new EncryptionKeyError(
      'ENCRYPTION_KEY_CREATE_FAILED',
      `Unable to create encryption key (${systemErrorCode(error)}).`,
      error
    );
  }
}

module.exports = {
  EncryptionKeyError,
  loadOrCreateEncryptionKey,
  validateEncryptionKey
};
