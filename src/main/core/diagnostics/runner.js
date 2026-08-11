const { pendingResult, terminalResult, safeCode } = require('./results');
const { createResourceLimiter } = require('./limiter');

function copyMetadata(metadata) {
  try {
    return typeof structuredClone === 'function' ? structuredClone(metadata) : {};
  } catch (_) {
    return {};
  }
}

function copyResult(result) {
  return Object.assign({}, result, { metadata: copyMetadata(result.metadata) });
}

function createRunSnapshot(runId, checks) {
  const ids = new Set();
  for (const definition of checks) {
    if (ids.has(definition.id)) throw new TypeError('Duplicate diagnostic check id');
    if (typeof definition.guideId !== 'string' || !definition.guideId.trim()) {
      throw new TypeError('Diagnostic checks require a guideId');
    }
    ids.add(definition.id);
  }
  return { runId, checks: checks.map(pendingResult) };
}

function runDiagnostics({
  runId,
  checks,
  emit = () => {},
  isActive = () => true,
  maxRemoteConcurrency = 3,
  signal,
  remoteLimiter,
  runScope,
  timers = {}
}) {
  createRunSnapshot(runId, checks);

  const setTimer = timers.setTimeout || setTimeout;
  const clearTimer = timers.clearTimeout || clearTimeout;
  const fallbackLimit = Number.isFinite(maxRemoteConcurrency) && maxRemoteConcurrency > 0
    ? Math.floor(maxRemoteConcurrency)
    : 3;
  const limiter = remoteLimiter && typeof remoteLimiter.acquire === 'function'
    ? remoteLimiter
    : createResourceLimiter(fallbackLimit);
  const terminalById = new Map();
  const isCurrent = () => {
    try {
      return !(signal && signal.aborted) && Boolean(isActive(runId));
    } catch (_) {
      return false;
    }
  };
  const orderedTerminalResults = () => checks
    .filter((definition) => terminalById.has(definition.id))
    .map((definition) => copyResult(terminalById.get(definition.id)));
  const emitIfCurrent = (check) => {
    if (!isCurrent()) return false;
    try {
      emit({ runId, check });
    } catch (_) {
      // Renderer notifications must not interrupt a diagnostics run.
    }
    return true;
  };

  async function runOne(definition, isRemote) {
    if (!isCurrent()) return undefined;
    if (!emitIfCurrent(Object.assign(pendingResult(definition), { status: 'running' })) || !isCurrent()) {
      return undefined;
    }

    const priorResults = orderedTerminalResults();
    const timeoutMs = definition.timeoutMs || 8000;
    const checkAbortController = new AbortController();
    const checkContext = {
      getResults: () => priorResults.map(copyResult),
      signal: checkAbortController.signal,
      deadlineMs: Date.now() + timeoutMs,
      runScope
    };
    let timer;
    let onRunAbort;
    let timedOut = false;
    let release;
    try {
      const operation = Promise.resolve()
        .then(async () => {
          if (isRemote) release = await limiter.acquire(checkAbortController.signal);
          return definition.run(checkContext);
        })
        .finally(() => {
          if (release) release();
        });
      const visibleBoundary = new Promise((_, reject) => {
        const rejectWith = (code, message) => {
          const error = new Error(message);
          error.code = code;
          reject(error);
        };
        onRunAbort = () => {
          rejectWith('DIAGNOSTIC_ABORTED', 'Diagnostics run aborted');
          checkAbortController.abort();
        };
        if (signal && signal.aborted) {
          onRunAbort();
          return;
        }
        if (signal && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onRunAbort, { once: true });
        }
        timer = setTimer(() => {
          timedOut = true;
          rejectWith('DIAGNOSTIC_TIMEOUT', 'Diagnostics check timed out');
          checkAbortController.abort();
        }, timeoutMs);
      });
      const value = await Promise.race([operation, visibleBoundary]);
      return terminalResult(definition, value.status, value);
    } catch (error) {
      const errorCode = timedOut ? 'DIAGNOSTIC_TIMEOUT' : safeCode(error && error.code);
      return terminalResult(definition, 'fail', {
        errorCode,
        summary: errorCode === 'DIAGNOSTIC_TIMEOUT'
          ? 'Diagnostic check timed out; see the troubleshooting guide'
          : 'Diagnostic check failed; see the troubleshooting guide'
      });
    } finally {
      if (timer !== undefined) {
        try {
          clearTimer(timer);
        } catch (_) {
          // A test or host timer implementation cannot prevent cleanup.
        }
      }
      if (signal && onRunAbort && typeof signal.removeEventListener === 'function') {
        try {
          signal.removeEventListener('abort', onRunAbort);
        } catch (_) {
          // A hostile signal cannot prevent cleanup.
        }
      }
    }
  }

  async function start(definition, isRemote = false) {
    if (!isCurrent()) return false;
    const result = await runOne(definition, isRemote);
    if (!result) return false;
    terminalById.set(definition.id, result);
    emitIfCurrent(copyResult(result));
    return true;
  }

  async function runSequential(definitions) {
    for (const definition of definitions) {
      if (!await start(definition)) break;
    }
  }

  async function runRemote(definitions) {
    let nextIndex = 0;
    const workerCount = Math.min(definitions.length, fallbackLimit);
    async function worker() {
      while (isCurrent() && nextIndex < definitions.length) {
        const definition = definitions[nextIndex];
        nextIndex += 1;
        await start(definition, true);
      }
    }
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  return (async () => {
    const local = checks.filter((definition) => definition.phase === 'local');
    const windows = checks.filter((definition) => definition.phase === 'windows');
    const remote = checks.filter((definition) => definition.phase === 'remote');
    const final = checks.filter((definition) => definition.phase === 'final');
    await runSequential(local);
    if (isCurrent()) await runSequential(windows);
    if (isCurrent()) await runRemote(remote);
    if (isCurrent()) await runSequential(final);
    return orderedTerminalResults();
  })();
}

module.exports = { createRunSnapshot, runDiagnostics };
