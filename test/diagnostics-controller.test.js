const test = require('node:test');
const assert = require('node:assert/strict');

const { createDiagnosticsController } = require('../src/main/core/diagnostics/controller');
const { createDiagnostics } = require('../src/main/core/diagnostics');
const { sanitizeDiagnosticResult } = require('../src/main/core/diagnostics/report');
const { createRunSnapshot } = require('../src/main/core/diagnostics/runner');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fakeSender(id) {
  let destroyed = false;
  const sent = [];
  return {
    id,
    sent,
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
    send(channel, payload) { sent.push({ channel, payload }); }
  };
}

function oneCheck() {
  return [{
    id: 'probe.safe',
    group: 'Probe',
    title: 'Safe probe',
    guideId: 'app-runtime',
    phase: 'local',
    timeoutMs: 3000,
    run: () => ({ status: 'pass' })
  }];
}

test('controller keeps sanitized runs owned by the exact live sender and ignores stale progress', async () => {
  const scheduled = [];
  const runs = [];
  const copied = [];
  const formatted = [];
  const opened = [];
  const runIds = ['run-a1', 'run-a2', 'run-b1'];
  const controller = createDiagnosticsController({
    checks: oneCheck(),
    randomUUID: () => runIds.shift(),
    setImmediate: (callback) => scheduled.push(callback),
    runDiagnostics(options) {
      const completion = deferred();
      runs.push({ options, completion });
      return completion.promise;
    },
    sanitizeDiagnosticResult,
    formatDiagnosticReport(snapshot, environment) {
      formatted.push({ snapshot, environment });
      return JSON.stringify(snapshot);
    },
    safeEnvironment: () => ({ appVersion: '1.0.0', homeDir: 'C:\\Users\\private' }),
    clipboard: { writeText: (text) => copied.push(text) },
    openGuide: async (guideId) => { opened.push(guideId); return { ok: true }; }
  });
  const senderA = fakeSender(101);
  const senderB = fakeSender(202);

  const first = controller.start(senderA);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  const second = controller.start(senderA);
  assert.equal(first instanceof Promise, false);
  assert.equal(first.runId, 'run-a1');
  assert.equal(first.checks[0].status, 'pending');
  assert.equal(second.runId, 'run-a2');
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.equal(runs.length, 2);

  runs[0].options.emit({
    runId: 'run-a1',
    check: {
      id: 'probe.safe', group: 'Probe', title: 'Safe probe', status: 'pass',
      summary: 'old', errorCode: null, guideId: 'app-runtime', metadata: { apiKey: 'sk-private-old' }
    }
  });
  runs[1].options.emit({
    runId: 'forged-run-id',
    check: {
      id: 'probe.safe', group: 'Probe', title: 'Safe probe', status: 'pass',
      summary: 'forged', errorCode: null, guideId: 'app-runtime', metadata: {}
    }
  });
  runs[1].options.emit({
    runId: 'run-a2',
    check: {
      id: 'probe.unknown', group: 'Probe', title: 'Unknown', status: 'pass',
      summary: 'unknown', errorCode: null, guideId: 'app-runtime', metadata: {}
    }
  });
  assert.equal(senderA.sent.length, 0);

  runs[1].options.emit({
    runId: 'run-a2',
    check: {
      id: 'probe.safe', group: 'Probe', title: 'Safe probe', status: 'pass',
      summary: 'current', errorCode: null, guideId: 'app-runtime',
      metadata: { apiKey: 'sk-private', nested: { authorization: 'Bearer private', count: 1 } }
    }
  });
  assert.equal(senderA.sent.length, 1);
  assert.equal(senderA.sent[0].channel, 'diagnostics:progress');
  assert.equal(senderA.sent[0].payload.runId, 'run-a2');
  assert.doesNotMatch(JSON.stringify(senderA.sent[0]), /sk-private|Bearer private/);

  assert.deepEqual(await controller.copy(senderA, 'run-a1'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_RUN_INVALID'
  });
  assert.deepEqual(await controller.copy(senderB, 'run-a2'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_RUN_INVALID'
  });
  assert.deepEqual(await controller.copy({ ...senderA }, 'run-a2'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_RUN_INVALID'
  });
  const copyResult = await controller.copy(senderA, 'run-a2');
  assert.deepEqual(copyResult, { ok: true, length: copied[0].length });
  assert.equal(formatted.length, 1);
  assert.equal(formatted[0].snapshot.runId, 'run-a2');
  assert.doesNotMatch(copied[0], /sk-private|Bearer private/);

  assert.deepEqual(await controller.openGuide(senderA, '../secret'), {
    ok: false,
    errorCode: 'INVALID_GUIDE_ID'
  });
  assert.deepEqual(await controller.openGuide(senderA, 'app-runtime'), { ok: true });
  assert.deepEqual(opened, ['app-runtime']);

  senderA.destroy();
  runs[1].options.emit({ runId: 'run-a2', check: senderA.sent[0].payload.check });
  assert.deepEqual(await controller.copy(senderA, 'run-a2'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_RUN_INVALID'
  });
  assert.deepEqual(await controller.openGuide(senderA, 'app-runtime'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_RUN_INVALID'
  });
  assert.equal(senderA.sent.length, 1);
  assert.equal(copied.length, 1);
  assert.equal(opened.length, 1);

  controller.dispose(101);
  assert.deepEqual(await controller.copy(senderA, 'run-a2'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_RUN_INVALID'
  });
  runs[0].completion.resolve([]);
  runs[1].completion.resolve([]);
  await Promise.all([runs[0].completion.promise, runs[1].completion.promise]);
});

test('controller contains dependency throws and rejections without leaking or reviving disposed runs', async () => {
  const scheduled = [];
  const sender = fakeSender(303);
  sender.send = () => { throw new Error('renderer gone'); };
  let mode = 'runner-sync';
  const controller = createDiagnosticsController({
    checks: oneCheck(),
    randomUUID: () => 'stable-run',
    setImmediate: (callback) => scheduled.push(callback),
    runDiagnostics() {
      if (mode === 'runner-sync') throw new Error('raw runner secret');
      return Promise.reject(new Error('raw runner rejection'));
    },
    sanitizeDiagnosticResult(result) {
      if (result.summary === 'bad sanitizer') throw new Error('sanitizer secret');
      return sanitizeDiagnosticResult(result);
    },
    formatDiagnosticReport() { throw new Error('formatter secret'); },
    safeEnvironment() { throw new Error('environment secret'); },
    clipboard: { writeText() { throw new Error('clipboard secret'); } },
    openGuide() { return Promise.reject(new Error('guide secret')); }
  });

  const snapshot = controller.start(sender);
  assert.equal(snapshot.runId, 'stable-run');
  assert.doesNotThrow(() => scheduled.shift()());
  assert.deepEqual(await controller.copy(sender, 'stable-run'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_REPORT_FAILED'
  });
  assert.deepEqual(await controller.openGuide(sender, 'app-runtime'), {
    ok: false,
    errorCode: 'GUIDE_OPEN_FAILED'
  });

  mode = 'runner-reject';
  controller.start(sender);
  scheduled.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  controller.dispose(sender.id);
  assert.deepEqual(await controller.copy(sender, 'stable-run'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_RUN_INVALID'
  });

  const rejectionQueue = [];
  let runnerOptions;
  let formatterMode = 'reject';
  let clipboardMode = 'reject';
  const rejectingController = createDiagnosticsController({
    checks: oneCheck(),
    randomUUID: () => 'rejecting-run',
    setImmediate: (callback) => rejectionQueue.push(callback),
    runDiagnostics(options) { runnerOptions = options; return Promise.resolve([]); },
    sanitizeDiagnosticResult(result) {
      if (result.summary === 'sanitizer rejection') {
        return Promise.reject(new Error('sanitizer rejected secret'));
      }
      return sanitizeDiagnosticResult(result);
    },
    formatDiagnosticReport() {
      return formatterMode === 'reject'
        ? Promise.reject(new Error('formatter rejected secret'))
        : 'safe report';
    },
    clipboard: {
      writeText() {
        return clipboardMode === 'reject'
          ? Promise.reject(new Error('clipboard rejected secret'))
          : Promise.resolve();
      }
    },
    openGuide: async () => ({ ok: true })
  });
  const throwingSender = fakeSender(404);
  throwingSender.send = () => { throw new Error('send secret'); };
  rejectingController.start(throwingSender);
  rejectionQueue.shift()();
  runnerOptions.emit({
    runId: 'rejecting-run',
    check: {
      id: 'probe.safe', group: 'Probe', title: 'Safe probe', status: 'pass',
      summary: 'sanitizer rejection', errorCode: null, guideId: 'app-runtime', metadata: {}
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await rejectingController.copy(throwingSender, 'rejecting-run'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_REPORT_FAILED'
  });
  formatterMode = 'ok';
  assert.deepEqual(await rejectingController.copy(throwingSender, 'rejecting-run'), {
    ok: false,
    errorCode: 'DIAGNOSTICS_REPORT_FAILED'
  });
  clipboardMode = 'ok';
  assert.deepEqual(await rejectingController.copy(throwingSender, 'rejecting-run'), {
    ok: true,
    length: 'safe report'.length
  });
});

test('assembly orders all factories, keeps scheduler metadata fixed, and injects every predecessor into self-check', async () => {
  const schedulerSecret = 'HTTP 503 https://private.example?token=secret Bearer secret';
  const diagnostics = createDiagnostics({
    runtime: {
      versions: { app: '1', electron: '2', node: '3', chromium: '4' },
      platform: 'linux', arch: 'x64', release: 'test',
      buildPaths: { mainRenderer: 'main', preload: 'preload', diagnosticsPage: 'diagnostics', fs: { accessSync() {} } },
      getWindows: () => ({})
    },
    storage: {
      fs: { constants: { R_OK: 4, W_OK: 2 } },
      crypto: { randomBytes: () => Buffer.alloc(12) },
      path: require('node:path'),
      userDataDir: 'unused',
      store: { get: (key) => key === 'data.historyDays' ? 7 : '' },
      validateEncryptionKey() {},
      normalizeStoredProxyValue() { return ''; }
    },
    windows: { platform: 'linux' },
    network: { store: { get: () => '' } },
    providers: { store: { get: () => undefined } },
    scheduler: {
      getSnapshot: () => [{
        id: 'deepseek', authStatus: 'expired', quota: { private: true },
        lastError: schedulerSecret, lastErrorChannel: 'usage',
        lastFailedAt: 10, lastFetchedAt: 9, stale: true,
        accessToken: 'provider-private'
      }]
    }
  });

  const ids = diagnostics.checks.map((check) => check.id);
  assert.equal(ids.at(-1), 'runtime.self-check');
  assert.ok(ids.indexOf('runtime.versions') < ids.indexOf('storage.user-data-access'));
  assert.ok(ids.indexOf('storage.user-data-access') < ids.indexOf('windows.platform-build'));
  assert.ok(ids.indexOf('windows.platform-build') < ids.indexOf('network.proxy-config'));
  assert.ok(ids.indexOf('network.proxy-config') < ids.indexOf('deepseek.api-key'));
  assert.ok(ids.indexOf('deepseek.api-key') < ids.indexOf('scheduler.deepseek'));
  assert.ok(ids.indexOf('scheduler.deepseek') < ids.indexOf('runtime.self-check'));
  assert.equal(new Set(ids).size, ids.length);
  assert.doesNotThrow(() => createRunSnapshot('contract', diagnostics.checks));

  const schedulerCheck = diagnostics.checks.find((check) => check.id === 'scheduler.deepseek');
  const observation = await schedulerCheck.run();
  assert.deepEqual(Object.keys(observation.metadata).sort(), [
    'authStatus', 'lastErrorChannel', 'lastFailedAt', 'lastFetchedAt', 'stale'
  ]);
  assert.doesNotMatch(JSON.stringify(observation), /private|secret|Bearer|quota|accessToken/i);

  const selfCheck = diagnostics.checks.at(-1);
  const terminal = diagnostics.checks.slice(0, -1).map((check) => ({ id: check.id, status: 'pass' }));
  assert.equal(selfCheck.phase, 'final');
  assert.equal(selfCheck.run({ getResults: () => terminal }).status, 'pass');
  assert.equal(
    selfCheck.run({ getResults: () => terminal.filter((result) => result.id !== 'scheduler.deepseek') }).status,
    'fail'
  );

  const resilient = createDiagnostics({
    factories: { storage: () => { throw new Error('factory secret'); } },
    runtime: { platform: 'linux', buildPaths: {}, getWindows: () => ({}) },
    scheduler: { getSnapshot: () => [] }
  });
  assert.ok(resilient.checks.some((check) => check.id === 'assembly.storage'));
  assert.doesNotThrow(() => createRunSnapshot('resilient-contract', resilient.checks));
});
