const STATUSES = Object.freeze(['pending', 'running', 'pass', 'fail', 'skipped']);

function safeCode(value, fallback = 'DIAGNOSTIC_FAILED') {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(value)
    ? value
    : fallback;
}

function base(definition, status) {
  if (!STATUSES.includes(status)) throw new TypeError('Invalid diagnostic status');
  return {
    id: definition.id,
    group: definition.group,
    title: definition.title,
    status,
    summary: '',
    errorCode: null,
    guideId: definition.guideId,
    metadata: {}
  };
}

function pendingResult(definition) {
  return base(definition, 'pending');
}

function terminalResult(definition, status, fields = {}) {
  if (!['pass', 'fail', 'skipped'].includes(status)) throw new TypeError('Invalid terminal status');
  const result = Object.assign(base(definition, status), {
    summary: typeof fields.summary === 'string' ? fields.summary : '',
    metadata: fields.metadata && typeof fields.metadata === 'object' ? fields.metadata : {}
  });
  if (status === 'fail') result.errorCode = safeCode(fields.errorCode);
  return result;
}

module.exports = { STATUSES, pendingResult, terminalResult, safeCode };
