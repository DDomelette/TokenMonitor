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
  const id = ownValue(sender, 'id');
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
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

function createDiagnosticsController(dependencies = {}) {
  const deps = dependencies && typeof dependencies === 'object' ? dependencies : {};
  const checks = Array.isArray(deps.checks) ? deps.checks.slice() : [];
  const createSnapshot = typeof deps.createRunSnapshot === 'function' ? deps.createRunSnapshot : createRunSnapshot;
  const execute = typeof deps.runDiagnostics === 'function' ? deps.runDiagnostics : runDiagnostics;
  const sanitize = typeof deps.sanitizeDiagnosticResult === 'function'
    ? deps.sanitizeDiagnosticResult
    : sanitizeDiagnosticResult;
  const format = typeof deps.formatDiagnosticReport === 'function'
    ? deps.formatDiagnosticReport
    : formatDiagnosticReport;
  const uuid = typeof deps.randomUUID === 'function' ? deps.randomUUID : crypto.randomUUID;
  const schedule = typeof deps.setImmediate === 'function' ? deps.setImmediate : setImmediate;
  const records = new Map();

  function sanitizeOne(result) {
    try {
      const value = sanitize(result);
      if (consumeThenable(value)) return null;
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  }

  function recordFor(sender, runId) {
    const id = senderId(sender);
    if (id === null || !senderIsLive(sender)) return null;
    const record = records.get(id);
    return record && record.sender === sender && record.runId === runId ? record : null;
  }

  function environmentSnapshot() {
    try {
      const environment = typeof deps.safeEnvironment === 'function' ? deps.safeEnvironment() : {};
      if (consumeThenable(environment)) return {};
      return environment && typeof environment === 'object' ? environment : {};
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
    const rawSnapshot = createSnapshot(runId, checks);
    const sanitizedChecks = rawSnapshot.checks.map(sanitizeOne).filter(Boolean);
    const allowedIds = new Set(sanitizedChecks.map((check) => ownValue(check, 'id')).filter((value) => typeof value === 'string'));
    const record = {
      runId,
      checks: sanitizedChecks,
      environment: environmentSnapshot(),
      sender,
      allowedIds
    };
    records.set(id, record);

    const emit = (event) => {
      if (records.get(id) !== record || !senderIsLive(sender)) return;
      if (ownValue(event, 'runId') !== runId) return;
      const safeCheck = sanitizeOne(ownValue(event, 'check'));
      const checkId = ownValue(safeCheck, 'id');
      if (!safeCheck || typeof checkId !== 'string' || !record.allowedIds.has(checkId)) return;
      const index = record.checks.findIndex((check) => ownValue(check, 'id') === checkId);
      if (index < 0) return;
      record.checks[index] = safeCheck;
      const completed = record.checks.reduce((count, check) => (
        TERMINAL.has(ownValue(check, 'status')) ? count + 1 : count
      ), 0);
      try {
        sender.send('diagnostics:progress', {
          runId,
          check: safeCheck,
          completed,
          total: record.checks.length
        });
      } catch (_) {
        // A closed renderer must never interrupt or leak a diagnostics run.
      }
    };

    try {
      schedule(() => {
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
    } catch (_) {
      // Scheduling failure leaves a stable pending snapshot that can still be copied.
    }

    return { runId, checks: record.checks.slice() };
  }

  async function copy(sender, runId) {
    const record = recordFor(sender, runId);
    if (!record) return invalidRun();
    try {
      const report = await format({ runId: record.runId, checks: record.checks.slice() }, record.environment);
      if (typeof report !== 'string') throw new TypeError('Diagnostics report must be text');
      if (!recordFor(sender, runId)) return invalidRun();
      if (!deps.clipboard || typeof deps.clipboard.writeText !== 'function') throw new Error('Clipboard unavailable');
      await deps.clipboard.writeText(report);
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
      const opener = typeof deps.openGuide === 'function'
        ? deps.openGuide
        : (value) => openGuide(value, {
            shell: deps.shell,
            environment: deps.guideEnvironment
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
