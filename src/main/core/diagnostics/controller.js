const crypto = require('node:crypto');
const { createRunSnapshot, runDiagnostics } = require('./runner');
const { sanitizeDiagnosticResult, formatDiagnosticReport } = require('./report');
const { GUIDE_IDS, openGuide } = require('./guides');

const TERMINAL = new Set(['pass', 'fail', 'skipped']);

function ownValue(source, key) {
  if (!source || typeof source !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch (_) {
    return undefined;
  }
}

function senderId(sender) {
  try {
    const id = Reflect.get(sender, 'id');
    return Number.isSafeInteger(id) && id >= 0 ? id : null;
  } catch (_) {
    return null;
  }
}

function senderIsLive(sender) {
  if (!sender || typeof sender !== 'object') return false;
  try {
    return typeof sender.isDestroyed !== 'function' || !sender.isDestroyed();
  } catch (_) {
    return false;
  }
}

function invalidRun() {
  return { ok: false, errorCode: 'DIAGNOSTICS_RUN_INVALID' };
}

function consumeThenable(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  let then;
  try {
    then = value.then;
  } catch (_) {
    return true;
  }
  if (typeof then !== 'function') return false;
  try {
    const returned = then.call(value, () => {}, () => {});
    if (returned && returned !== value && (typeof returned === 'object' || typeof returned === 'function')) {
      try {
        const catchMethod = returned.catch;
        if (typeof catchMethod === 'function') catchMethod.call(returned, () => {});
      } catch (_) {
        // A hostile returned thenable is discarded after its rejection path is consumed.
      }
    }
  } catch (_) {
    // Synchronous thenable failures are treated as sanitizer failures.
  }
  return true;
}

function dependency(source, key) {
  try {
    return source && (typeof source === 'object' || typeof source === 'function')
      ? Reflect.get(source, key)
      : undefined;
  } catch (_) {
    return undefined;
  }
}

function copyEnvironment(source) {
  const environment = {};
  for (const key of ['appVersion', 'platform', 'release', 'arch', 'electron', 'homeDir']) {
    const value = ownValue(source, key);
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      environment[key] = value;
    }
  }
  return environment;
}

function createDiagnosticsController(dependencies = {}) {
  const deps = dependencies && typeof dependencies === 'object' ? dependencies : {};
  const configuredChecks = dependency(deps, 'checks');
  const checks = Array.isArray(configuredChecks) ? configuredChecks.slice() : [];
  const configuredCreateSnapshot = dependency(deps, 'createRunSnapshot');
  const configuredExecute = dependency(deps, 'runDiagnostics');
  const configuredSanitize = dependency(deps, 'sanitizeDiagnosticResult');
  const configuredFormat = dependency(deps, 'formatDiagnosticReport');
  const configuredUuid = dependency(deps, 'randomUUID');
  const configuredSchedule = dependency(deps, 'setImmediate');
  const createSnapshot = typeof configuredCreateSnapshot === 'function' ? configuredCreateSnapshot : createRunSnapshot;
  const execute = typeof configuredExecute === 'function' ? configuredExecute : runDiagnostics;
  const sanitize = typeof configuredSanitize === 'function'
    ? configuredSanitize
    : sanitizeDiagnosticResult;
  const format = typeof configuredFormat === 'function'
    ? configuredFormat
    : formatDiagnosticReport;
  const uuid = typeof configuredUuid === 'function' ? configuredUuid : crypto.randomUUID;
  const schedule = typeof configuredSchedule === 'function' ? configuredSchedule : setImmediate;
  const records = new Map();

  function sanitizeOne(result, environment) {
    try {
      const value = sanitize(result, environment);
      if (consumeThenable(value)) return null;
      if (!value || typeof value !== 'object') return null;
      return sanitizeDiagnosticResult(value, environment);
    } catch (_) {
      return null;
    }
  }

  function cloneResult(result, environment) {
    try {
      return sanitizeDiagnosticResult(result, environment);
    } catch (_) {
      return null;
    }
  }

  function cloneChecks(source, environment) {
    const cloned = [];
    for (const result of source) {
      const copy = cloneResult(result, environment);
      if (copy) cloned.push(copy);
    }
    return cloned;
  }

  function recordFor(sender, runId) {
    const id = senderId(sender);
    if (id === null || !senderIsLive(sender)) return null;
    const record = records.get(id);
    return record && record.sender === sender && record.runId === runId ? record : null;
  }

  function environmentSnapshot() {
    try {
      const safeEnvironment = dependency(deps, 'safeEnvironment');
      const environment = typeof safeEnvironment === 'function' ? safeEnvironment() : {};
      if (consumeThenable(environment)) return {};
      return environment && typeof environment === 'object' ? copyEnvironment(environment) : {};
    } catch (_) {
      return {};
    }
  }

  function start(sender) {
    const id = senderId(sender);
    if (id === null || !senderIsLive(sender)) {
      const error = new Error('Invalid diagnostics sender');
      error.code = 'DIAGNOSTICS_SENDER_INVALID';
      throw error;
    }

    const runId = uuid();
    const environment = environmentSnapshot();
    const rawSnapshot = createSnapshot(runId, checks);
    const rawChecks = ownValue(rawSnapshot, 'checks');
    const sanitizedChecks = Array.isArray(rawChecks)
      ? rawChecks.map((result) => sanitizeOne(result, environment)).filter(Boolean)
      : [];
    const allowedIds = new Set(sanitizedChecks.map((check) => ownValue(check, 'id')).filter((value) => typeof value === 'string'));
    const record = {
      runId,
      checks: sanitizedChecks,
      environment,
      sender,
      allowedIds
    };
    records.set(id, record);

    const emit = (event) => {
      if (records.get(id) !== record || !senderIsLive(sender)) return;
      if (ownValue(event, 'runId') !== runId) return;
      const safeCheck = sanitizeOne(ownValue(event, 'check'), record.environment);
      const checkId = ownValue(safeCheck, 'id');
      if (!safeCheck || typeof checkId !== 'string' || !record.allowedIds.has(checkId)) return;
      const index = record.checks.findIndex((check) => ownValue(check, 'id') === checkId);
      if (index < 0) return;
      const storedCheck = cloneResult(safeCheck, record.environment);
      const sentCheck = cloneResult(safeCheck, record.environment);
      if (!storedCheck || !sentCheck) return;
      record.checks[index] = storedCheck;
      const completed = record.checks.reduce((count, check) => (
        TERMINAL.has(ownValue(check, 'status')) ? count + 1 : count
      ), 0);
      try {
        const sendResult = sender.send('diagnostics:progress', {
          runId,
          check: sentCheck,
          completed,
          total: record.checks.length
        });
        consumeThenable(sendResult);
      } catch (_) {
        // A closed renderer must never interrupt or leak a diagnostics run.
      }
    };

    try {
      const scheduled = schedule(() => {
        if (records.get(id) !== record || !senderIsLive(sender)) return;
        try {
          const completion = execute({
            runId,
            checks,
            emit,
            isActive: () => records.get(id) === record && senderIsLive(sender)
          });
          Promise.resolve(completion).catch(() => {});
        } catch (_) {
          // Runner construction and synchronous execution failures are isolated.
        }
      });
      consumeThenable(scheduled);
    } catch (_) {
      // Scheduling failure leaves a stable pending snapshot that can still be copied.
    }

    return { runId, checks: cloneChecks(record.checks, record.environment) };
  }

  async function copy(sender, runId) {
    const record = recordFor(sender, runId);
    if (!record) return invalidRun();
    try {
      const report = await format(
        { runId: record.runId, checks: cloneChecks(record.checks, record.environment) },
        copyEnvironment(record.environment)
      );
      if (typeof report !== 'string') throw new TypeError('Diagnostics report must be text');
      if (!recordFor(sender, runId)) return invalidRun();
      const clipboard = dependency(deps, 'clipboard');
      if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
      await clipboard.writeText(report);
      if (!recordFor(sender, runId)) return invalidRun();
      return { ok: true, length: report.length };
    } catch (_) {
      return { ok: false, errorCode: 'DIAGNOSTICS_REPORT_FAILED' };
    }
  }

  async function openWhitelistedGuide(sender, guideId) {
    const id = senderId(sender);
    const record = id === null ? null : records.get(id);
    if (!record || record.sender !== sender || !senderIsLive(sender)) return invalidRun();
    if (!GUIDE_IDS.has(guideId)) return { ok: false, errorCode: 'INVALID_GUIDE_ID' };
    try {
      const configuredOpenGuide = dependency(deps, 'openGuide');
      const opener = typeof configuredOpenGuide === 'function'
        ? configuredOpenGuide
        : (value) => openGuide(value, {
            shell: dependency(deps, 'shell'),
            environment: dependency(deps, 'guideEnvironment')
          });
      const result = await opener(guideId);
      if (!records.has(id) || records.get(id) !== record || !senderIsLive(sender)) return invalidRun();
      return result && typeof result === 'object'
        ? result
        : { ok: false, errorCode: 'GUIDE_OPEN_FAILED' };
    } catch (_) {
      return { ok: false, errorCode: 'GUIDE_OPEN_FAILED' };
    }
  }

  function dispose(id) {
    if (Number.isSafeInteger(id) && id >= 0) records.delete(id);
  }

  return { start, copy, openGuide: openWhitelistedGuide, dispose };
}

module.exports = { createDiagnosticsController };
