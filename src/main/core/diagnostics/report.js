const SENSITIVE_METADATA_KEY = /api.?key|session|access.?token|refresh.?token|authorization|encryption.?key/i;
const DIAGNOSTIC_FIELDS = ['id', 'group', 'title', 'status', 'summary', 'errorCode', 'guideId'];
const ENVIRONMENT_FIELDS = ['appVersion', 'platform', 'release', 'arch', 'electron'];

function readOwnDataProperty(source, key) {
  if (!source || typeof source !== 'object') return { found: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? { found: true, value: descriptor.value }
      : { found: false };
  } catch {
    return { found: false };
  }
}

function safeArrayLength(value) {
  const length = readOwnDataProperty(value, 'length');
  return length.found && Number.isSafeInteger(length.value) && length.value >= 0 ? length.value : 0;
}

function redactText(value, options = {}) {
  let text;
  if (value === undefined || value === null) {
    text = '';
  } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    text = String(value);
  } else {
    return '<unsupported>';
  }

  const homeDirValue = readOwnDataProperty(options, 'homeDir');
  const homeDir = homeDirValue.found && typeof homeDirValue.value === 'string' ? homeDirValue.value : '';
  if (homeDir) text = text.split(homeDir).join('~');
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-jwt>')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\b(api[_-]?key|session[_-]?token|access[_-]?token|refresh[_-]?token|encryption[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>');
}

function sanitizeMetadata(value, options, depth) {
  if (value === null || typeof value !== 'object') {
    if (value === undefined || typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol') {
      return '<unsupported>';
    }
    return typeof value === 'string' ? redactText(value, options) : value;
  }

  if (depth >= 4) return '<redacted-depth>';

  if (Array.isArray(value)) {
    const sanitized = [];
    for (let index = 0; index < safeArrayLength(value); index += 1) {
      const item = readOwnDataProperty(value, String(index));
      sanitized.push(item.found
        ? sanitizeMetadata(item.value, options, depth + 1)
        : '<unsupported>');
    }
    return sanitized;
  }

  const sanitized = Object.create(null);
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    return sanitized;
  }
  for (const key of keys) {
    const item = readOwnDataProperty(value, key);
    if (item.found && !SENSITIVE_METADATA_KEY.test(key)) {
      sanitized[key] = sanitizeMetadata(item.value, options, depth + 1);
    }
  }
  return sanitized;
}

function sanitizeDiagnosticResult(result, options = {}) {
  const source = result && typeof result === 'object' ? result : {};
  const sanitized = {};
  for (const field of DIAGNOSTIC_FIELDS) {
    const item = readOwnDataProperty(source, field);
    if (item.found) {
      sanitized[field] = redactText(item.value, options);
    }
  }
  const metadata = readOwnDataProperty(source, 'metadata');
  sanitized.metadata = sanitizeMetadata(metadata.found && metadata.value && typeof metadata.value === 'object' ? metadata.value : {}, options, -1);
  return sanitized;
}

function formatDiagnosticReport(snapshot, environment = {}) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const safeEnvironmentSource = environment && typeof environment === 'object' ? environment : {};
  const safeEnvironment = {};
  for (const field of ENVIRONMENT_FIELDS) {
    const item = readOwnDataProperty(safeEnvironmentSource, field);
    if (item.found) {
      safeEnvironment[field] = redactText(item.value, safeEnvironmentSource);
    }
  }
  const checksValue = readOwnDataProperty(source, 'checks');
  const checks = [];
  if (checksValue.found && Array.isArray(checksValue.value)) {
    for (let index = 0; index < safeArrayLength(checksValue.value); index += 1) {
      const result = readOwnDataProperty(checksValue.value, String(index));
      if (result.found) checks.push(sanitizeDiagnosticResult(result.value, safeEnvironmentSource));
    }
  }
  const runId = readOwnDataProperty(source, 'runId');

  return [
    '# Diagnostics Report',
    '',
    `Run ID: ${redactText(runId.found ? runId.value : '', safeEnvironmentSource)}`,
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
