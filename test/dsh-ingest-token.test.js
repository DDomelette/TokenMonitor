const test = require('node:test');
const assert = require('node:assert/strict');
const { INGEST_TOKEN_KEY, ensureIngestToken, rotateIngestToken } = require('../src/main/providers/dsh/ingest/token');

test('ensureIngestToken generates and persists a 48-char hex token when missing', () => {
  const data = {};
  const store = { get(k) { return data[k]; }, set(k, v) { data[k] = v; } };
  const token = ensureIngestToken(store);
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(store.get(INGEST_TOKEN_KEY), token);
});

test('rotateIngestToken replaces the stored token', () => {
  const store = { data: { [INGEST_TOKEN_KEY]: 'old' }, get(k) { return this.data[k]; }, set(k, v) { this.data[k] = v; } };
  assert.notEqual(rotateIngestToken(store), 'old');
});
