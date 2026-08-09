const fs = require('node:fs');
const path = require('node:path');

const GUIDE_FILES = Object.freeze({
  'app-runtime': 'app-runtime.md',
  'storage-user-data': 'storage-user-data.md',
  'storage-config': 'storage-config.md',
  'windows-acrylic': 'windows-acrylic.md',
  'windows-gpu': 'windows-gpu.md',
  'network-proxy': 'network-proxy.md',
  'network-tls': 'network-tls.md',
  'deepseek-api-key': 'deepseek-api-key.md',
  'deepseek-session': 'deepseek-session.md',
  'codex-auth': 'codex-auth.md',
  'codex-local-log': 'codex-local-log.md',
  'kimi-auth': 'kimi-auth.md',
  'kimi-local-log': 'kimi-local-log.md'
});
const PRIVATE_GUIDE_IDS = new Set(Object.keys(GUIDE_FILES));
const immutableGuideIdsError = () => {
  throw new TypeError('GUIDE_IDS is immutable');
};
const GUIDE_IDS = Object.freeze({
  has(guideId) {
    return PRIVATE_GUIDE_IDS.has(guideId);
  },
  get size() {
    return PRIVATE_GUIDE_IDS.size;
  },
  [Symbol.iterator]() {
    return PRIVATE_GUIDE_IDS[Symbol.iterator]();
  },
  add: immutableGuideIdsError,
  delete: immutableGuideIdsError,
  clear: immutableGuideIdsError
});

function resolveGuidePath(guideId, environment = {}) {
  if (!PRIVATE_GUIDE_IDS.has(guideId)) return { ok: false, errorCode: 'INVALID_GUIDE_ID' };

  const safeEnvironment = environment && typeof environment === 'object' ? environment : {};
  const basePath = safeEnvironment.isPackaged ? safeEnvironment.resourcesPath : safeEnvironment.appPath;
  if (typeof basePath !== 'string' || basePath.length === 0) {
    return { ok: false, errorCode: 'GUIDE_NOT_FOUND' };
  }
  const guideRoot = safeEnvironment.isPackaged
    ? path.join(basePath, 'diagnostics-guides')
    : path.join(basePath, 'docs', 'diagnostics');
  const target = path.join(guideRoot, GUIDE_FILES[guideId]);

  try {
    if (!fs.statSync(target).isFile()) return { ok: false, errorCode: 'GUIDE_NOT_FOUND' };
  } catch {
    return { ok: false, errorCode: 'GUIDE_NOT_FOUND' };
  }
  return { ok: true, path: target };
}

async function openGuide(guideId, dependencies = {}) {
  const safeDependencies = dependencies && typeof dependencies === 'object' ? dependencies : {};
  const resolved = resolveGuidePath(guideId, safeDependencies.environment);
  if (!resolved.ok) return resolved;

  try {
    const shellError = await safeDependencies.shell.openPath(resolved.path);
    return shellError === '' ? { ok: true } : { ok: false, errorCode: 'GUIDE_OPEN_FAILED' };
  } catch {
    return { ok: false, errorCode: 'GUIDE_OPEN_FAILED' };
  }
}

module.exports = { GUIDE_IDS, resolveGuidePath, openGuide };
