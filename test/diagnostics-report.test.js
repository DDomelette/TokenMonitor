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

test('projects only documented metadata keys and normalizes quoted secrets and Windows home variants', () => {
  const unsafe = {
    accountId: 'unsafe-account-camel',
    account_id: 'unsafe-account-snake',
    path: 'c:/USERS/ALICE/private-path',
    fileName: 'unsafe-session-file.jsonl',
    stack: 'unsafe-stack-trace',
    credential: 'unsafe-credential',
    AcCoUnT_Id: 'unsafe-account-mixed',
    PaTh: 'unsafe-path-mixed',
    FILENAME: 'unsafe-file-mixed',
    sTaCk: 'unsafe-stack-mixed',
    CrEdEnTiAl: 'unsafe-credential-mixed'
  };
  const results = [
    {
      id: 'runtime.versions', group: 'Runtime', title: 'Versions', status: 'pass',
      summary: 'runtime', guideId: 'app-runtime',
      metadata: { app: '1.2.3', electron: '40.0.0', node: '22.0.0', chromium: '140.0.0', platform: 'win32', arch: 'x64', release: '10.0.26100', ...unsafe }
    },
    {
      id: 'network.proxy-config', group: 'Network', title: 'Proxy', status: 'pass',
      summary: 'proxy', guideId: 'network-proxy', metadata: { mode: 'direct', ...unsafe }
    },
    {
      id: 'network.system-proxy', group: 'Network', title: 'System proxy', status: 'pass',
      summary: 'stage', guideId: 'network-proxy', metadata: { stage: 'proxy-config', ...unsafe }
    },
    {
      id: 'deepseek.api-key', group: 'Provider', title: 'Key', status: 'pass',
      summary: 'configured', guideId: 'deepseek-api-key', metadata: { configured: true, ...unsafe }
    },
    {
      id: 'codex.sessions', group: 'Provider', title: 'Sessions', status: 'pass',
      summary: 'logs', guideId: 'codex-local-log', metadata: { matchingFiles: 2, ...unsafe }
    }
  ];
  const secretSummary = {
    ...results[1],
    summary: 'payload {"access_token": "quoted-json-secret"} at c:/USERS/ALICE/private-path'
  };
  const sanitized = results.map((result) => sanitizeDiagnosticResult(result, { homeDir: 'C:\\Users\\Alice' }));
  const report = formatDiagnosticReport({ runId: 'safe-run', checks: [secretSummary, ...results] }, {
    homeDir: 'C:\\Users\\Alice', appVersion: '1.2.3', platform: 'win32', release: '10.0.26100', arch: 'x64', electron: '40.0.0'
  });
  const allOutput = JSON.stringify(sanitized) + report;

  assert.deepEqual(sanitized[0].metadata, {
    app: '1.2.3', electron: '40.0.0', node: '22.0.0', chromium: '140.0.0',
    platform: 'win32', arch: 'x64', release: '10.0.26100'
  });
  assert.deepEqual(sanitized[1].metadata, { mode: 'direct' });
  assert.deepEqual(sanitized[2].metadata, { stage: 'proxy-config' });
  assert.deepEqual(sanitized[3].metadata, { configured: true });
  assert.deepEqual(sanitized[4].metadata, { matchingFiles: 2 });
  assert.doesNotMatch(allOutput, /unsafe-|quoted-json-secret|c:\/users\/alice|c:\\users\\alice/i);
  assert.match(report, /access_token(?:\\?"|)=<redacted>/i);
  assert.match(report, /~\/private-path/);
});

test('sanitizes metadata defensively without mutating the original diagnostic result', () => {
  const result = {
    id: 'network.proxy', group: 'Network', title: 'Proxy', status: 'fail',
    summary: 'session_token=private', errorCode: 'PROXY_FAILED', guideId: 'network-proxy',
    metadata: {
      apiKey: 'sk-private-value',
      stage: 'Bearer secret-value',
      nested: { one: { two: { three: { four: { five: 'not-exposed' } } } } }
    },
    unknown: 'must-not-be-copied'
  };

  const sanitized = sanitizeDiagnosticResult(result);

  assert.deepEqual(Object.keys(sanitized).sort(), ['errorCode', 'group', 'guideId', 'id', 'metadata', 'status', 'summary', 'title']);
  assert.equal(sanitized.metadata.apiKey, undefined);
  assert.equal(sanitized.metadata.stage, 'Bearer <redacted>');
  assert.equal(sanitized.metadata.nested, undefined);
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
      id: 'codex.sessions', group: 'Codex', title: 'Sessions', status: 'fail',
      summary: 'failed', errorCode: 'LOCAL_LOG_UNREADABLE', guideId: 'codex-local-log',
      metadata: { matchingFiles: 3n }
    }]
  });

  assert.match(report, /"matchingFiles": "<unsupported>"/);
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
      id: 'runtime.versions', group: 'Runtime', title: 'Versions', status: 'fail',
      summary: 'failed', errorCode: 'RUNTIME_VERSION_FAILED', guideId: 'app-runtime',
      metadata: { app: () => 'sk-private-leak', node: Symbol('private'), release: undefined }
    }]
  });

  assert.match(report, /"app": "<unsupported>"/);
  assert.match(report, /"node": "<unsupported>"/);
  assert.match(report, /"release": "<unsupported>"/);
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
      id: 'windows.gpu', group: 'Windows', title: 'GPU', status: 'fail',
      summary: 'failed', errorCode: 'WINDOWS_GPU', guideId: 'windows-gpu', metadata: { features: values }
    }]
  });

  assert.equal(getterCalls, 0);
  assert.doesNotMatch(report, /sk-private-leak/);
  assert.match(report, /"features": \{\}/);
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

test('fails closed when snapshot checks is a revoked array proxy', () => {
  const checks = Proxy.revocable([], {});
  checks.revoke();

  const report = formatDiagnosticReport({ checks: checks.proxy });

  assert.match(report, /## Checks\s+\[\]/);
});

test('fails closed when diagnostic metadata is a revoked object proxy', () => {
  const metadata = Proxy.revocable({}, {});
  metadata.revoke();

  const report = formatDiagnosticReport({
    checks: [{
      id: 'network.proxy', group: 'Network', title: 'Proxy', status: 'fail',
      summary: 'failed', errorCode: 'PROXY_FAILED', guideId: 'network-proxy', metadata: metadata.proxy
    }]
  });

  assert.match(report, /"metadata": \{\}/);
});
