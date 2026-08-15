const crypto = require('node:crypto');

const INGEST_TOKEN_KEY = 'ingest.dsh.token';

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function ensureIngestToken(store) {
  const existing = store.get(INGEST_TOKEN_KEY);
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const token = generateToken();
  store.set(INGEST_TOKEN_KEY, token);
  return token;
}

function rotateIngestToken(store) {
  const token = generateToken();
  store.set(INGEST_TOKEN_KEY, token);
  return token;
}

module.exports = { INGEST_TOKEN_KEY, ensureIngestToken, rotateIngestToken };
