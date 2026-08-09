const { pendingResult, terminalResult, safeCode } = require('./results');

function copyValue(value) {
  if (Array.isArray(value)) return value.map(copyValue);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).reduce((copy, key) => {
      copy[key] = copyValue(value[key]);
      return copy;
    }, {});
  }
  return value;
}

function copyResult(result) {
  return Object.assign({}, result, { metadata: copyValue(result.metadata) });
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
  timers = {}
}) {
  createRunSnapshot(runId, checks);

  const setTimer = timers.setTimeout || setTimeout;
  const clearTimer = timers.clearTimeout || clearTimeout;
  const terminalById = new Map();
  const isCurrent = () => {
    try {
      return Boolean(isActive(runId));
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

  async function runOne(definition) {
    if (!isCurrent()) return undefined;
    if (!emitIfCurrent(Object.assign(pendingResult(definition), { status: 'running' })) || !isCurrent()) {
      return undefined;
    }
    const priorResults = orderedTerminalResults();
    const checkContext = { getResults: () => priorResults.map(copyResult) };
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => definition.run(checkContext)),
        new Promise((_, reject) => {
          timer = setTimer(() => reject(Object.assign(new Error('timeout'), {
            code: 'DIAGNOSTIC_TIMEOUT'
          })), definition.timeoutMs || 8000);
        })
      ]);
      return terminalResult(definition, value.status, value);
    } catch (error) {
      return terminalResult(definition, 'fail', {
        errorCode: safeCode(error && error.code),
        summary: error && error.code === 'DIAGNOSTIC_TIMEOUT'
          ? '检查超时，请查看解决手册'
          : '检查失败，请查看解决手册'
      });
    } finally {
      if (timer !== undefined) {
        try {
          clearTimer(timer);
        } catch (_) {
          // A test or host timer implementation cannot prevent cleanup.
        }
      }
    }
  }

  async function start(definition) {
    if (!isCurrent()) return false;
    const result = await runOne(definition);
    if (!result) return false;
    terminalById.set(definition.id, result);
    emitIfCurrent(result);
    return true;
  }

  async function runSequential(definitions) {
    for (const definition of definitions) {
      if (!await start(definition)) break;
    }
  }

  async function runRemote(definitions) {
    let nextIndex = 0;
    const workerCount = Math.min(
      definitions.length,
      Number.isFinite(maxRemoteConcurrency) && maxRemoteConcurrency > 0
        ? Math.floor(maxRemoteConcurrency)
        : 3
    );
    async function worker() {
      while (isCurrent() && nextIndex < definitions.length) {
        const definition = definitions[nextIndex];
        nextIndex += 1;
        await start(definition);
      }
    }
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  return (async () => {
    const sequential = checks.filter((definition) => definition.phase === 'local' || definition.phase === 'windows');
    const remote = checks.filter((definition) => definition.phase === 'remote');
    const final = checks.filter((definition) => definition.phase === 'final');
    await runSequential(sequential);
    if (isCurrent()) await runRemote(remote);
    if (isCurrent()) await runSequential(final);
    return orderedTerminalResults();
  })();
}

module.exports = { createRunSnapshot, runDiagnostics };
