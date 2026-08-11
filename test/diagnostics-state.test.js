const test = require('node:test');
const assert = require('node:assert/strict');

function check(id, status, fields = {}) {
  return Object.assign({
    id,
    group: 'Runtime',
    title: `Check ${id}`,
    status,
    summary: '',
    errorCode: null,
    guideId: 'app-runtime',
    metadata: {}
  }, fields);
}

const pending = (id) => check(id, 'pending');

test('a new diagnostics run replaces prior results without retaining mutable snapshot references', () => {
  const DiagnosticsState = require('../src/renderer/js/diagnostics-state.js');
  const sourceCheck = pending('runtime.a');
  const snapshot = { runId: 'run-new', checks: [sourceCheck, pending('runtime.b')] };

  const state = DiagnosticsState.startRun(DiagnosticsState.createState(), snapshot);
  sourceCheck.status = 'fail';
  snapshot.checks.reverse();

  assert.equal(state.runId, 'run-new');
  assert.deepEqual(
    DiagnosticsState.orderedChecks(state).map((item) => [item.id, item.status]),
    [['runtime.a', 'pending'], ['runtime.b', 'pending']]
  );
});

test('progress updates only a known check in the active run and preserves snapshot order', () => {
  const DiagnosticsState = require('../src/renderer/js/diagnostics-state.js');
  let state = DiagnosticsState.startRun(DiagnosticsState.createState(), {
    runId: 'new',
    checks: [pending('a'), pending('b')]
  });

  const beforeStale = state;
  state = DiagnosticsState.applyProgress(state, { runId: 'old', check: check('a', 'pass') });
  assert.equal(state, beforeStale);
  assert.equal(DiagnosticsState.orderedChecks(state)[0].status, 'pending');

  const beforeUnknown = state;
  state = DiagnosticsState.applyProgress(state, { runId: 'new', check: check('unknown', 'fail') });
  assert.equal(state, beforeUnknown);

  state = DiagnosticsState.applyProgress(state, { runId: 'new', check: check('a', 'pass') });
  assert.deepEqual(DiagnosticsState.orderedChecks(state).map((item) => item.id), ['a', 'b']);
  assert.deepEqual(DiagnosticsState.summary(state), {
    total: 2,
    pending: 1,
    running: 0,
    pass: 1,
    fail: 0,
    skipped: 0,
    complete: false
  });
});

test('summary counts every allowed status and completes only after pending and running are gone', () => {
  const DiagnosticsState = require('../src/renderer/js/diagnostics-state.js');
  let state = DiagnosticsState.startRun(DiagnosticsState.createState(), {
    runId: 'counts',
    checks: [
      check('pending', 'pending'),
      check('running', 'running'),
      check('pass', 'pass'),
      check('fail', 'fail'),
      check('skipped', 'skipped')
    ]
  });

  assert.deepEqual(DiagnosticsState.summary(state), {
    total: 5,
    pending: 1,
    running: 1,
    pass: 1,
    fail: 1,
    skipped: 1,
    complete: false
  });

  state = DiagnosticsState.applyProgress(state, {
    runId: 'counts',
    check: check('pending', 'skipped')
  });
  state = DiagnosticsState.applyProgress(state, {
    runId: 'counts',
    check: check('running', 'pass')
  });

  assert.equal(DiagnosticsState.summary(state).complete, true);
});
