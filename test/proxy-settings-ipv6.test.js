const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeCustomProxyUrl,
  parseSystemProxyResult
} = require('../src/main/core/proxy-settings');

test('custom HTTP proxy normalization preserves one bracket pair for IPv6 hosts', () => {
  assert.equal(
    normalizeCustomProxyUrl('http://[::1]:7890'),
    'http://[::1]:7890'
  );
});

test('Electron PROXY directives preserve one bracket pair for IPv6 hosts', () => {
  assert.equal(
    parseSystemProxyResult('PROXY [::1]:7890'),
    'http://[::1]:7890'
  );
});
