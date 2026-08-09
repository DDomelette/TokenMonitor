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
class ImmutableGuideSet extends Set {
  constructor(values) {
    super();
    for (const value of values) Set.prototype.add.call(this, value);
    Object.freeze(this);
  }

  add() {
    throw new TypeError('GUIDE_IDS is immutable');
  }

  delete() {
    throw new TypeError('GUIDE_IDS is immutable');
  }

  clear() {
    throw new TypeError('GUIDE_IDS is immutable');
  }
}

const GUIDE_IDS = new ImmutableGuideSet(Object.keys(GUIDE_FILES));

function resolveGuidePath(guideId, environment = {}) {
  if (!GUIDE_IDS.has(guideId)) return { ok: false, errorCode: 'INVALID_GUIDE_ID' };

  const basePath = environment.isPackaged ? environment.resourcesPath : environment.appPath;
  if (typeof basePath !== 'string' || basePath.length === 0) {
    return { ok: false, errorCode: 'GUIDE_NOT_FOUND' };
  }
  const guideRoot = environment.isPackaged
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
  const resolved = resolveGuidePath(guideId, dependencies.environment);
  if (!resolved.ok) return resolved;

  try {
    const shellError = await dependencies.shell.openPath(resolved.path);
    return shellError === '' ? { ok: true } : { ok: false, errorCode: 'GUIDE_OPEN_FAILED' };
  } catch {
    return { ok: false, errorCode: 'GUIDE_OPEN_FAILED' };
  }
}

module.exports = { GUIDE_IDS, resolveGuidePath, openGuide };
