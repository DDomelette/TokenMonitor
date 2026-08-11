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

test('resource limiter holds permits until explicit release and removes aborted waiters', async () => {
  const { createResourceLimiter } = require('../src/main/core/diagnostics/limiter');
  const limiter = createResourceLimiter(1);
  const firstRelease = await limiter.acquire();
  const controller = new AbortController();
  const waiting = limiter.acquire(controller.signal);

  assert.equal(limiter.active, 1);
  assert.equal(limiter.pending, 1);
  controller.abort();
  await assert.rejects(waiting, (error) => error && error.code === 'DIAGNOSTIC_ABORTED');
  assert.equal(limiter.active, 1);
  assert.equal(limiter.pending, 0);

  firstRelease();
  firstRelease();
  assert.equal(limiter.active, 0);
  assert.equal(limiter.pending, 0);
});

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

test('remote checks default to a three-worker pool', async () => {
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
    runId: 'run-3', checks, emit() {}, isActive: () => true
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 3);
  gates.forEach((gate) => gate.resolve());
  const results = await running;
  assert.deepEqual(results.map((item) => item.status), ['pass', 'pass', 'pass', 'pass']);
});

test('shared limiter caps underlying resources across runs and timeout abort drains cancelable operations', async () => {
  const { createResourceLimiter } = require('../src/main/core/diagnostics/limiter');
  const limiter = createResourceLimiter(3);
  let active = 0;
  let peak = 0;
  function abortableRemote(id) {
    return check(id, 'remote', (context) => new Promise((resolve, reject) => {
      active += 1;
      peak = Math.max(peak, active);
      if (!context.signal || typeof context.signal.addEventListener !== 'function') return;
      context.signal.addEventListener('abort', () => {
        active -= 1;
        const error = new Error('aborted');
        error.code = 'DIAGNOSTIC_ABORTED';
        reject(error);
      }, { once: true });
    }), 5);
  }
  const first = runDiagnostics({
    runId: 'shared-a',
    checks: Array.from({ length: 4 }, (_, index) => abortableRemote(`a.${index}`)),
    emit() {},
    isActive: () => true,
    remoteLimiter: limiter,
    signal: new AbortController().signal
  });
  const second = runDiagnostics({
    runId: 'shared-b',
    checks: Array.from({ length: 4 }, (_, index) => abortableRemote(`b.${index}`)),
    emit() {},
    isActive: () => true,
    remoteLimiter: limiter,
    signal: new AbortController().signal
  });

  const [firstResults, secondResults] = await Promise.all([first, second]);
  assert.equal(firstResults.every((item) => item.errorCode === 'DIAGNOSTIC_TIMEOUT'), true);
  assert.equal(secondResults.every((item) => item.errorCode === 'DIAGNOSTIC_TIMEOUT'), true);
  assert.ok(peak <= 3, `underlying resource peak was ${peak}`);
  assert.equal(active, 0);
  assert.equal(limiter.active, 0);
});

test('timed-out non-cancelable operation retains its shared permit until it really settles', async () => {
  const { createResourceLimiter } = require('../src/main/core/diagnostics/limiter');
  const limiter = createResourceLimiter(1);
  const nonCancelable = deferred();
  let secondStarted = false;
  const first = runDiagnostics({
    runId: 'non-cancelable-a',
    checks: [check('remote.old', 'remote', () => nonCancelable.promise, 5)],
    emit() {}, isActive: () => true, remoteLimiter: limiter
  });
  const firstResults = await first;
  assert.equal(firstResults[0].errorCode, 'DIAGNOSTIC_TIMEOUT');
  assert.equal(limiter.active, 1);

  const second = runDiagnostics({
    runId: 'non-cancelable-b',
    checks: [check('remote.new', 'remote', async () => {
      secondStarted = true;
      return { status: 'pass' };
    }, 50)],
    emit() {}, isActive: () => true, remoteLimiter: limiter
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondStarted, false);
  nonCancelable.resolve({ status: 'pass' });
  assert.equal((await second)[0].status, 'pass');
  assert.equal(limiter.active, 0);
});

test('runner executes local and windows as separate ordered phases', async () => {
  const order = [];
  const phaseCheck = (id, phase) => check(id, phase, async () => {
    order.push(id);
    return { status: 'pass' };
  });
  await runDiagnostics({
    runId: 'phase-order',
    checks: [
      phaseCheck('local.first', 'local'),
      phaseCheck('windows.first', 'windows'),
      phaseCheck('local.second', 'local'),
      phaseCheck('windows.second', 'windows'),
      phaseCheck('remote.first', 'remote'),
      phaseCheck('final.first', 'final')
    ],
    emit() {}, isActive: () => true
  });
  assert.deepEqual(order, [
    'local.first', 'local.second',
    'windows.first', 'windows.second',
    'remote.first', 'final.first'
  ]);
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

test('snapshots reject whitespace-only guide ids while allowing trimmed nonempty ids', () => {
  const definition = check('guide-id', 'local', async () => ({ status: 'pass' }));
  assert.throws(() => createRunSnapshot('run-8', [Object.assign({}, definition, { guideId: '  ' })]), /guideId/);
  assert.throws(() => createRunSnapshot('run-9', [Object.assign({}, definition, { guideId: '\t' })]), /guideId/);
  assert.doesNotThrow(() => createRunSnapshot('run-10', [Object.assign({}, definition, { guideId: ' app-runtime ' })]));
});

test('getResults isolates top-level and nested metadata from a final check mutation', async () => {
  let afterMutation;
  const checks = [
    check('completed', 'local', async () => ({
      status: 'pass', summary: 'original', metadata: { nested: { value: 'original' } }
    })),
    check('final', 'final', async (context) => {
      const previous = context.getResults();
      previous[0].summary = 'mutated';
      previous[0].metadata.nested.value = 'mutated';
      afterMutation = context.getResults();
      return { status: 'pass' };
    })
  ];

  const results = await runDiagnostics({ runId: 'run-11', checks, emit() {}, isActive: () => true });
  assert.equal(afterMutation[0].summary, 'original');
  assert.equal(afterMutation[0].metadata.nested.value, 'original');
  assert.equal(results[0].summary, 'original');
  assert.equal(results[0].metadata.nested.value, 'original');
});

test('a running event that makes the run stale does not start the check or timer', async () => {
  let active = true;
  let timerCount = 0;
  const called = [];
  const events = [];
  const results = await runDiagnostics({
    runId: 'run-12',
    checks: [check('stale-on-running', 'local', async () => {
      called.push('run');
      return { status: 'pass' };
    })],
    emit(event) {
      events.push(event.check.status);
      if (event.check.status === 'running') active = false;
    },
    isActive: () => active,
    timers: {
      setTimeout() { timerCount += 1; return timerCount; },
      clearTimeout() {}
    }
  });

  assert.deepEqual(called, []);
  assert.equal(timerCount, 0);
  assert.deepEqual(events, ['running']);
  assert.deepEqual(results, []);
});

test('terminal event mutations do not change final context or returned results', async () => {
  let finalResults;
  const checks = [
    check('emitted', 'local', async () => ({
      status: 'pass',
      summary: 'original',
      metadata: { nested: { value: 'original', date: new Date('2020-01-01T00:00:00.000Z') } }
    })),
    check('final', 'final', async (context) => {
      finalResults = context.getResults();
      return { status: 'pass' };
    })
  ];
  const results = await runDiagnostics({
    runId: 'run-13', checks,
    emit(event) {
      if (event.check.id === 'emitted' && event.check.status === 'pass') {
        event.check.summary = 'mutated';
        event.check.metadata.nested.value = 'mutated';
        event.check.metadata.nested.date.setUTCFullYear(2030);
      }
    },
    isActive: () => true
  });

  assert.equal(finalResults[0].summary, 'original');
  assert.equal(finalResults[0].metadata.nested.value, 'original');
  assert.equal(finalResults[0].metadata.nested.date.getUTCFullYear(), 2020);
  assert.equal(results[0].summary, 'original');
  assert.equal(results[0].metadata.nested.value, 'original');
  assert.equal(results[0].metadata.nested.date.getUTCFullYear(), 2020);
});

test('uncloneable metadata fails closed in final context and returned results', async () => {
  let finalResults;
  const checks = [
    check('uncloneable', 'local', async () => ({
      status: 'pass', metadata: { callback() {} }
    })),
    check('final', 'final', async (context) => {
      finalResults = context.getResults();
      return { status: 'pass' };
    })
  ];

  const results = await runDiagnostics({ runId: 'run-14', checks, emit() {}, isActive: () => true });
  assert.deepEqual(finalResults[0].metadata, {});
  assert.deepEqual(results[0].metadata, {});
});
