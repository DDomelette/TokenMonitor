const assert = require('node:assert/strict');
const test = require('node:test');

const {
  redactText,
  sanitizeDiagnosticResult,
  formatDiagnosticReport
} = require('../src/main/core/diagnostics/report');

test('redacts tokens, JWTs, and the home directory from diagnostic reports', () => {
  const snapshot = {
    runId: 'run-secret',
    checks: [{
      id: 'codex.auth', group: 'Codex', title: 'Auth', status: 'fail',
      summary: 'Bearer eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.x refresh_token=refresh-private C:\\Users\\Alice\\.codex',
      errorCode: 'AUTH_FAILED', guideId: 'codex-auth', metadata: { apiKey: 'sk-private-value' }
    }],
    internalToken: 'sess-private-value'
  };

  const report = formatDiagnosticReport(snapshot, {
    appVersion: '1.0.0', platform: 'win32', release: '10.0.26100', arch: 'x64',
    electron: '40.0.0', homeDir: 'C:\\Users\\Alice', internalToken: 'must-not-serialize'
  });

  assert.doesNotMatch(report, /sk-private|refresh-private|eyJhbGci|C:\\Users\\Alice|must-not-serialize/);
  assert.match(report, /~\\\.codex|<redacted>/);
});

test('sanitizes metadata defensively without mutating the original diagnostic result', () => {
  const result = {
    id: 'network.proxy', group: 'Network', title: 'Proxy', status: 'fail',
    summary: 'session_token=private', errorCode: 'PROXY_FAILED', guideId: 'network-proxy',
    metadata: {
      apiKey: 'sk-private-value',
      safe: 'Bearer secret-value',
      nested: { one: { two: { three: { four: { five: 'not-exposed' } } } } }
    },
    unknown: 'must-not-be-copied'
  };

  const sanitized = sanitizeDiagnosticResult(result);

  assert.deepEqual(Object.keys(sanitized).sort(), ['errorCode', 'group', 'guideId', 'id', 'metadata', 'status', 'summary', 'title']);
  assert.equal(sanitized.metadata.apiKey, undefined);
  assert.equal(sanitized.metadata.safe, 'Bearer <redacted>');
  assert.equal(sanitized.metadata.nested.one.two.three.four, '<redacted-depth>');
  assert.equal(result.metadata.apiKey, 'sk-private-value');
  assert.equal(result.metadata.nested.one.two.three.four.five, 'not-exposed');
});

test('redactText safely normalizes absent values', () => {
  assert.equal(redactText(null), '');
  assert.equal(redactText('access-token: private-value'), 'access-token=<redacted>');
});
