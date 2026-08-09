const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunSnapshot, runDiagnostics } = require('../src/main/core/diagnostics/runner');

function check(id, phase, run, timeoutMs = 50) {
  return { id, phase, run, timeoutMs, group: 'Test', title: id, guideId: 'app-runtime' };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('runner emits pending snapshot then running and terminal results in definition order', async () => {
  const checks = [
    check('local.ok', 'local', async () => ({ status: 'pass', summary: 'ok' })),
    check('remote.skip', 'remote', async () => ({ status: 'skipped', summary: 'not configured' }))
  ];
  const events = [];

  assert.deepEqual(createRunSnapshot('run-1', checks).checks.map((item) => item.status), ['pending', 'pending']);
  const results = await runDiagnostics({
    runId: 'run-1', checks, emit: (event) => events.push(event), isActive: () => true
  });

  assert.deepEqual(results.map((item) => item.status), ['pass', 'skipped']);
  assert.deepEqual(events.map((event) => event.check.status), ['running', 'pass', 'running', 'skipped']);
});

test('one exception and one timeout fail without preventing the next check', async () => {
  const never = new Promise(() => {});
  const results = await runDiagnostics({
    runId: 'run-2',
    checks: [
      check('throws', 'local', async () => { throw Object.assign(new Error('private'), { code: 'EACCES' }); }),
      check('times-out', 'local', async () => never, 5),
      check('continues', 'local', async () => ({ status: 'pass', summary: 'continued' }))
    ],
    emit() {}, isActive: () => true
  });

  assert.deepEqual(results.map((item) => item.status), ['fail', 'fail', 'pass']);
  assert.equal(results[1].errorCode, 'DIAGNOSTIC_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(results), /private/);
});

test('a completed check clears a zero-valued injected timer handle', async () => {
  const cleared = [];
  await runDiagnostics({
    runId: 'run-timer',
    checks: [check('timer', 'local', async () => ({ status: 'pass' }))],
    emit() {}, isActive: () => true,
    timers: {
      setTimeout() { return 0; },
      clearTimeout(handle) { cleared.push(handle); }
    }
  });
  assert.deepEqual(cleared, [0]);
});

test('remote checks use a bounded worker pool', async () => {
  const gates = [deferred(), deferred(), deferred(), deferred()];
  let active = 0;
  let peak = 0;
  const checks = gates.map((gate, index) => check(`remote.${index}`, 'remote', async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate.promise;
    active -= 1;
    return { status: 'pass', summary: 'done' };
  }));

  const running = runDiagnostics({
    runId: 'run-3', checks, emit() {}, isActive: () => true, maxRemoteConcurrency: 3
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 3);
  gates.forEach((gate) => gate.resolve());
  const results = await running;
  assert.deepEqual(results.map((item) => item.status), ['pass', 'pass', 'pass', 'pass']);
});

test('a stale run stops before later checks start or emit events', async () => {
  const called = [];
  let active = true;
  const events = [];
  const results = await runDiagnostics({
    runId: 'run-4',
    checks: [
      check('first', 'local', async () => { called.push('first'); return { status: 'pass' }; }),
      check('later', 'local', async () => { called.push('later'); return { status: 'pass' }; })
    ],
    emit(event) {
      events.push(event);
      if (event.check.status === 'pass') active = false;
    },
    isActive: () => active
  });

  assert.deepEqual(called, ['first']);
  assert.deepEqual(events.map((event) => event.check.status), ['running', 'pass']);
  assert.deepEqual(results.map((item) => item.id), ['first']);
});

test('the final phase receives completed terminal results and snapshots reject unmapped checks', async () => {
  const observed = [];
  const checks = [
    check('local', 'local', async () => ({ status: 'pass' })),
    check('remote', 'remote', async () => ({ status: 'pass' })),
    check('final', 'final', async (context) => {
      observed.push(context.getResults().map((result) => result.id));
      return { status: 'pass' };
    })
  ];

  await runDiagnostics({ runId: 'run-5', checks, emit() {}, isActive: () => true });
  assert.deepEqual(observed, [['local', 'remote']]);
  assert.throws(() => createRunSnapshot('run-6', [checks[0], Object.assign({}, checks[0])]), /duplicate/i);
  assert.throws(() => createRunSnapshot('run-7', [Object.assign({}, checks[0], { guideId: '' })]), /guideId/);
});
