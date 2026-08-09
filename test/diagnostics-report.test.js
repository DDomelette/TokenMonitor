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

test('does not invoke metadata toJSON while formatting a diagnostic report', () => {
  let toJSONCalls = 0;
  const report = formatDiagnosticReport({
    checks: [{
      id: 'codex.auth', group: 'Codex', title: 'Auth', status: 'fail',
      summary: 'failed', errorCode: 'AUTH_FAILED', guideId: 'codex-auth',
      metadata: {
        toJSON() {
          toJSONCalls += 1;
          return 'sk-private-leak';
        }
      }
    }]
  });

  assert.equal(toJSONCalls, 0);
  assert.doesNotMatch(report, /sk-private-leak/);
});

test('normalizes BigInt metadata so diagnostic reports remain JSON-safe', () => {
  const report = formatDiagnosticReport({
    checks: [{
      id: 'network.proxy', group: 'Network', title: 'Proxy', status: 'fail',
      summary: 'failed', errorCode: 'PROXY_FAILED', guideId: 'network-proxy',
      metadata: { retryCount: 3n }
    }]
  });

  assert.match(report, /"retryCount": "<unsupported>"/);
});

test('does not invoke enumerable metadata getters while formatting reports', () => {
  let getterCalls = 0;
  const metadata = {};
  Object.defineProperty(metadata, 'credential', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'sk-private-leak';
    }
  });

  const report = formatDiagnosticReport({
    checks: [{
      id: 'network.proxy', group: 'Network', title: 'Proxy', status: 'fail',
      summary: 'failed', errorCode: 'PROXY_FAILED', guideId: 'network-proxy', metadata
    }]
  });

  assert.equal(getterCalls, 0);
  assert.doesNotMatch(report, /sk-private-leak/);
});

test('normalizes unsupported metadata primitives to stable JSON-safe placeholders', () => {
  const report = formatDiagnosticReport({
    checks: [{
      id: 'network.proxy', group: 'Network', title: 'Proxy', status: 'fail',
      summary: 'failed', errorCode: 'PROXY_FAILED', guideId: 'network-proxy',
      metadata: { callback: () => 'sk-private-leak', marker: Symbol('private'), absent: undefined }
    }]
  });

  assert.match(report, /"callback": "<unsupported>"/);
  assert.match(report, /"marker": "<unsupported>"/);
  assert.match(report, /"absent": "<unsupported>"/);
  assert.doesNotMatch(report, /sk-private-leak/);
});

test('redactText does not invoke object conversion hooks and accepts null options', () => {
  let toStringCalls = 0;
  const value = {
    toString() {
      toStringCalls += 1;
      return 'sk-private-leak';
    },
    toJSON() {
      throw new Error('must not run');
    }
  };

  assert.equal(redactText(value, null), '<unsupported>');
  assert.equal(toStringCalls, 0);
});

test('does not invoke accessor array entries in metadata', () => {
  let getterCalls = 0;
  const values = [];
  Object.defineProperty(values, '0', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'sk-private-leak';
    }
  });
  values.length = 1;

  const report = formatDiagnosticReport({
    checks: [{
      id: 'network.proxy', group: 'Network', title: 'Proxy', status: 'fail',
      summary: 'failed', errorCode: 'PROXY_FAILED', guideId: 'network-proxy', metadata: { values }
    }]
  });

  assert.equal(getterCalls, 0);
  assert.doesNotMatch(report, /sk-private-leak/);
  assert.match(report, /"values": \[\s+"<unsupported>"\s+\]/);
});

test('does not invoke a diagnostic result summary accessor', () => {
  let calls = 0;
  const result = {
    id: 'codex.auth', group: 'Codex', title: 'Auth', status: 'fail',
    errorCode: 'AUTH_FAILED', guideId: 'codex-auth', metadata: {}
  };
  Object.defineProperty(result, 'summary', {
    enumerable: true,
    get() {
      calls += 1;
      throw new Error('sk-private-summary');
    }
  });

  const report = formatDiagnosticReport({ checks: [result] });

  assert.equal(calls, 0);
  assert.doesNotMatch(report, /sk-private-summary/);
});

test('does not invoke a diagnostic result metadata accessor', () => {
  let calls = 0;
  const result = {
    id: 'codex.auth', group: 'Codex', title: 'Auth', status: 'fail',
    summary: 'failed', errorCode: 'AUTH_FAILED', guideId: 'codex-auth'
  };
  Object.defineProperty(result, 'metadata', {
    enumerable: true,
    get() {
      calls += 1;
      throw new Error('sk-private-metadata');
    }
  });

  const report = formatDiagnosticReport({ checks: [result] });

  assert.equal(calls, 0);
  assert.doesNotMatch(report, /sk-private-metadata/);
});

test('does not invoke snapshot runId or checks accessors', () => {
  let runIdCalls = 0;
  let checksCalls = 0;
  const snapshot = {};
  Object.defineProperty(snapshot, 'runId', {
    enumerable: true,
    get() {
      runIdCalls += 1;
      throw new Error('sk-private-run-id');
    }
  });
  Object.defineProperty(snapshot, 'checks', {
    enumerable: true,
    get() {
      checksCalls += 1;
      throw new Error('sk-private-checks');
    }
  });

  const report = formatDiagnosticReport(snapshot);

  assert.equal(runIdCalls, 0);
  assert.equal(checksCalls, 0);
  assert.doesNotMatch(report, /sk-private-run-id|sk-private-checks/);
});

test('does not invoke environment platform or homeDir accessors', () => {
  let platformCalls = 0;
  let homeDirCalls = 0;
  const environment = { appVersion: '1.0.0' };
  Object.defineProperty(environment, 'platform', {
    enumerable: true,
    get() {
      platformCalls += 1;
      throw new Error('sk-private-platform');
    }
  });
  Object.defineProperty(environment, 'homeDir', {
    enumerable: true,
    get() {
      homeDirCalls += 1;
      throw new Error('sk-private-home');
    }
  });

  const report = formatDiagnosticReport({ checks: [] }, environment);

  assert.equal(platformCalls, 0);
  assert.equal(homeDirCalls, 0);
  assert.doesNotMatch(report, /sk-private-platform|sk-private-home/);
});

test('fails closed when metadata proxy reflection traps throw', () => {
  const metadata = new Proxy({}, {
    ownKeys() {
      throw new Error('sk-private-proxy');
    }
  });

  const report = formatDiagnosticReport({
    checks: [{
      id: 'network.proxy', group: 'Network', title: 'Proxy', status: 'fail',
      summary: 'failed', errorCode: 'PROXY_FAILED', guideId: 'network-proxy', metadata
    }]
  });

  assert.doesNotMatch(report, /sk-private-proxy/);
  assert.match(report, /"metadata": \{\}/);
});
