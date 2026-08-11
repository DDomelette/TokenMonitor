const DIAGNOSTIC_FIELDS = ['id', 'group', 'title', 'status', 'summary', 'errorCode', 'guideId'];
const ENVIRONMENT_FIELDS = ['appVersion', 'platform', 'release', 'arch', 'electron'];
const LEAF = true;
const GPU_FEATURE_FIELDS = Object.freeze({
  '2d_canvas': LEAF,
  canvas_oop_rasterization: LEAF,
  direct_rendering_display_compositor: LEAF,
  gpu_compositing: LEAF,
  multiple_raster_threads: LEAF,
  opengl: LEAF,
  rasterization: LEAF,
  raw_draw: LEAF,
  skia_graphite: LEAF,
  video_decode: LEAF,
  video_encode: LEAF,
  vulkan: LEAF,
  webgl: LEAF,
  webgl2: LEAF,
  webgpu: LEAF
});
const METADATA_SCHEMAS = Object.freeze({
  'runtime.versions': Object.freeze({
    app: LEAF, electron: LEAF, node: LEAF, chromium: LEAF,
    platform: LEAF, arch: LEAF, release: LEAF
  }),
  'runtime.window-references': Object.freeze({
    main: LEAF, settings: LEAF, login: LEAF, session: LEAF, diagnostics: LEAF
  }),
  'storage.encryption-state': Object.freeze({ keyValid: LEAF }),
  'storage.settings-schema': Object.freeze({ proxyValid: LEAF, historyDaysValid: LEAF }),
  'network.proxy-config': Object.freeze({ mode: LEAF }),
  'network.system-proxy': Object.freeze({ stage: LEAF }),
  'network.custom-proxy': Object.freeze({ stage: LEAF }),
  'network.deepseek-api': Object.freeze({ stage: LEAF, host: LEAF }),
  'network.deepseek-platform': Object.freeze({ stage: LEAF, host: LEAF }),
  'network.codex': Object.freeze({ stage: LEAF, host: LEAF }),
  'network.kimi': Object.freeze({ stage: LEAF, host: LEAF }),
  'network.proxy': Object.freeze({ stage: LEAF, mode: LEAF, host: LEAF }),
  'deepseek.api-key': Object.freeze({ configured: LEAF }),
  'deepseek.session': Object.freeze({ configured: LEAF }),
  'codex.auth': Object.freeze({
    configured: LEAF, hasRefreshToken: LEAF, hasAccountId: LEAF, expiry: LEAF
  }),
  'codex.sessions': Object.freeze({ matchingFiles: LEAF }),
  'codex.local-log': Object.freeze({ matchingFiles: LEAF, sampledLines: LEAF, parsedRecords: LEAF }),
  'codex.quota': Object.freeze({ credentialState: LEAF }),
  'kimi.auth': Object.freeze({ configured: LEAF, hasRefreshToken: LEAF, expiry: LEAF }),
  'kimi.sessions': Object.freeze({ matchingFiles: LEAF }),
  'kimi.local-log': Object.freeze({ matchingFiles: LEAF, sampledLines: LEAF, parsedRecords: LEAF }),
  'kimi.quota': Object.freeze({ credentialState: LEAF }),
  'windows.native-libraries': Object.freeze({
    libraries: Object.freeze({ user32: LEAF, dwmapi: LEAF, gdi32: LEAF })
  }),
  'windows.gpu': Object.freeze({
    features: GPU_FEATURE_FIELDS,
    auxAttributes: Object.freeze({ amdSwitchable: LEAF, optimus: LEAF })
  })
});
const SCHEDULER_METADATA_SCHEMA = Object.freeze({
  authStatus: LEAF,
  lastErrorChannel: LEAF,
  lastFailedAt: LEAF,
  lastFetchedAt: LEAF,
  stale: LEAF
});
const EMPTY_METADATA_SCHEMA = Object.freeze({});

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

function safeIsArray(value) {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactHomePath(text, homeDir) {
  if (!homeDir) return text;
  const segments = homeDir.split(/[\\/]+/).filter(Boolean);
  if (!segments.length) return text;
  try {
    return text.replace(new RegExp(segments.map(escapeRegExp).join('[\\\\/]+'), 'gi'), '~');
  } catch (_) {
    return text;
  }
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
  text = redactHomePath(text, homeDir);
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-jwt>')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/(["']?)(api[_-]?key|session[_-]?token|access[_-]?token|refresh[_-]?token|encryption[_-]?key)(["']?)\s*[:=]\s*(["'])[^"'\r\n]*\4/gi, '$1$2$3=<redacted>')
    .replace(/\b(api[_-]?key|session[_-]?token|access[_-]?token|refresh[_-]?token|encryption[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>');
}

function metadataSchemaForId(id) {
  if (typeof id !== 'string') return EMPTY_METADATA_SCHEMA;
  if (id.startsWith('scheduler.')) return SCHEDULER_METADATA_SCHEMA;
  return METADATA_SCHEMAS[id] || EMPTY_METADATA_SCHEMA;
}

function sanitizeMetadata(value, options, schema) {
  if (!schema || schema === LEAF) {
    if (value === undefined || typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol') {
      return '<unsupported>';
    }
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    return typeof value === 'string' ? redactText(value, options) : '<unsupported>';
  }

  const sanitized = {};
  if (!value || typeof value !== 'object' || safeIsArray(value)) return sanitized;
  for (const key of Object.keys(schema)) {
    const item = readOwnDataProperty(value, key);
    if (item.found) sanitized[key] = sanitizeMetadata(item.value, options, schema[key]);
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
  const id = readOwnDataProperty(source, 'id');
  sanitized.metadata = sanitizeMetadata(
    metadata.found && metadata.value && typeof metadata.value === 'object' ? metadata.value : {},
    options,
    metadataSchemaForId(id.found ? id.value : undefined)
  );
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
  if (checksValue.found && safeIsArray(checksValue.value)) {
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
