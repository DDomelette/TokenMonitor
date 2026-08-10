const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMcpToken, rotateMcpToken } = require('../src/main/mcp/token');

function makeStore(seed) {
  const data = Object.assign({}, seed);
  return { data, get(k) { return data[k]; }, set(k, v) { data[k] = v; } };
}

test('ensureMcpToken generates and persists a 48-char hex token when missing', () => {
  const store = makeStore({});
  const token = ensureMcpToken(store);
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(store.get('mcp.token'), token);
});

test('ensureMcpToken keeps an existing token', () => {
  const store = makeStore({ 'mcp.token': 'existing-token' });
  assert.equal(ensureMcpToken(store), 'existing-token');
});

test('rotateMcpToken always replaces the stored token', () => {
  const store = makeStore({ 'mcp.token': 'old' });
  const next = rotateMcpToken(store);
  assert.match(next, /^[0-9a-f]{48}$/);
  assert.notEqual(next, 'old');
  assert.equal(store.get('mcp.token'), next);
});
