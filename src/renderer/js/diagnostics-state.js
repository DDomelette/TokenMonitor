(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.DiagnosticsState = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var STATUSES = ['pending', 'running', 'pass', 'fail', 'skipped'];

  function copyCheck(check) {
    var copy = Object.assign({}, check);
    copy.metadata = check && check.metadata && typeof check.metadata === 'object'
      ? Object.assign({}, check.metadata)
      : {};
    return copy;
  }

  function createState() {
    return {
      runId: null,
      order: [],
      checksById: Object.create(null)
    };
  }

  function startRun(state, snapshot) {
    var source = snapshot && Array.isArray(snapshot.checks) ? snapshot.checks : [];
    var order = [];
    var checksById = Object.create(null);
    source.forEach(function (check) {
      if (!check || typeof check.id !== 'string' || checksById[check.id]) return;
      order.push(check.id);
      checksById[check.id] = copyCheck(check);
    });
    return {
      runId: snapshot && typeof snapshot.runId === 'string' ? snapshot.runId : null,
      order: order,
      checksById: checksById
    };
  }

  function applyProgress(state, event) {
    if (!state || !event || event.runId !== state.runId || !event.check ||
        typeof event.check.id !== 'string' || !state.checksById[event.check.id]) {
      return state;
    }
    var checksById = Object.assign(Object.create(null), state.checksById);
    checksById[event.check.id] = copyCheck(event.check);
    return {
      runId: state.runId,
      order: state.order,
      checksById: checksById
    };
  }

  function orderedChecks(state) {
    if (!state || !Array.isArray(state.order)) return [];
    return state.order.map(function (id) { return state.checksById[id]; });
  }

  function summary(state) {
    var counts = {
      total: 0,
      pending: 0,
      running: 0,
      pass: 0,
      fail: 0,
      skipped: 0,
      complete: true
    };
    orderedChecks(state).forEach(function (check) {
      counts.total += 1;
      if (check && STATUSES.indexOf(check.status) !== -1) counts[check.status] += 1;
    });
    counts.complete = counts.pending === 0 && counts.running === 0;
    return counts;
  }

  return {
    createState: createState,
    startRun: startRun,
    applyProgress: applyProgress,
    orderedChecks: orderedChecks,
    summary: summary
  };
});
