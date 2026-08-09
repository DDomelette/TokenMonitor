const SENSITIVE_METADATA_KEY = /api.?key|session|access.?token|refresh.?token|authorization|encryption.?key/i;
const DIAGNOSTIC_FIELDS = ['id', 'group', 'title', 'status', 'summary', 'errorCode', 'guideId'];
const ENVIRONMENT_FIELDS = ['appVersion', 'platform', 'release', 'arch', 'electron'];

function redactText(value, options = {}) {
  let text = String(value === undefined || value === null ? '' : value);
  if (options.homeDir) text = text.split(options.homeDir).join('~');
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-jwt>')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\b(api[_-]?key|session[_-]?token|access[_-]?token|refresh[_-]?token|encryption[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>');
}

function sanitizeMetadata(value, options, depth) {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? redactText(value, options) : value;
  }

  if (depth >= 4) return '<redacted-depth>';

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeMetadata(item, options, depth + 1));
  }

  const sanitized = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (!SENSITIVE_METADATA_KEY.test(key)) {
      sanitized[key] = sanitizeMetadata(nestedValue, options, depth + 1);
    }
  }
  return sanitized;
}

function sanitizeDiagnosticResult(result, options = {}) {
  const source = result && typeof result === 'object' ? result : {};
  const sanitized = {};
  for (const field of DIAGNOSTIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      sanitized[field] = redactText(source[field], options);
    }
  }
  sanitized.metadata = sanitizeMetadata(source.metadata && typeof source.metadata === 'object' ? source.metadata : {}, options, -1);
  return sanitized;
}

function formatDiagnosticReport(snapshot, environment = {}) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const safeEnvironment = {};
  for (const field of ENVIRONMENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(environment, field)) {
      safeEnvironment[field] = redactText(environment[field], environment);
    }
  }
  const checks = Array.isArray(source.checks)
    ? source.checks.map((result) => sanitizeDiagnosticResult(result, environment))
    : [];

  return [
    '# Diagnostics Report',
    '',
    `Run ID: ${redactText(source.runId, environment)}`,
    '',
    '## Environment',
    '',
    JSON.stringify(safeEnvironment, null, 2),
    '',
    '## Checks',
    '',
    JSON.stringify(checks, null, 2)
  ].join('\n');
}

module.exports = { redactText, sanitizeDiagnosticResult, formatDiagnosticReport };
