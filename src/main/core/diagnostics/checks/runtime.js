const fs = require('node:fs');

const TIMEOUT_MS = 3000;
const RUNTIME_GUIDE = 'app-runtime';

function definition(id, title, phase, run) {
  return { id, group: 'Runtime', title, guideId: RUNTIME_GUIDE, phase, timeoutMs: TIMEOUT_MS, run };
}

function artifactPaths(buildPaths) {
  const source = buildPaths && typeof buildPaths === 'object' ? buildPaths : {};
  return [
    source.mainRenderer || source.renderer || source.main,
    source.preload,
    source.diagnosticsPage || source.diagnostics
  ];
}

function createRuntimeChecks(dependencies = {}) {
  const versions = dependencies.versions || {};
  const platform = dependencies.platform;
  const accessFs = dependencies.buildPaths && dependencies.buildPaths.fs || fs;
  const getWindows = typeof dependencies.getWindows === 'function'
    ? dependencies.getWindows
    : () => ({});
  const defaultExpectedCheckIds = [
    'runtime.versions',
    'runtime.windows-build',
    'runtime.renderer-build',
    'runtime.ipc-roundtrip',
    'runtime.window-references'
  ];
  const expectedCheckIds = Array.isArray(dependencies.expectedCheckIds)
    ? dependencies.expectedCheckIds.slice()
    : defaultExpectedCheckIds;

  return [
    definition('runtime.versions', 'Runtime versions', 'local', () => ({
      status: 'pass',
      summary: 'Runtime version information is available',
      metadata: {
        app: versions.app,
        electron: versions.electron,
        node: versions.node,
        chromium: versions.chromium,
        platform,
        arch: dependencies.arch,
        release: dependencies.release
      }
    })),
    definition('runtime.windows-build', 'Windows runtime', 'windows', () => {
      if (platform !== 'win32') return { status: 'skipped', summary: 'Windows-only check' };
      return { status: 'pass', summary: 'Windows runtime is available' };
    }),
    definition('runtime.renderer-build', 'Renderer build artifacts', 'local', () => {
      const artifacts = artifactPaths(dependencies.buildPaths);
      try {
        if (artifacts.some((target) => typeof target !== 'string' || !target)) {
          return { status: 'fail', summary: 'Renderer build artifacts are not configured', errorCode: 'RENDERER_BUILD_MISSING' };
        }
        artifacts.forEach((target) => accessFs.accessSync(target));
        return { status: 'pass', summary: 'Renderer build artifacts are readable' };
      } catch (_) {
        return { status: 'fail', summary: 'Renderer build artifact is unavailable', errorCode: 'RENDERER_BUILD_MISSING' };
      }
    }),
    definition('runtime.ipc-roundtrip', 'Diagnostics IPC round-trip', 'local', () => ({
      status: 'pass',
      summary: 'Diagnostics IPC handler invoked this check'
    })),
    definition('runtime.window-references', 'Window references', 'local', () => {
      const windows = getWindows() || {};
      return {
        status: 'pass',
        summary: 'Window references inspected',
        metadata: {
          main: Boolean(windows.main),
          settings: Boolean(windows.settings),
          login: Boolean(windows.login),
          session: Boolean(windows.session)
        }
      };
    }),
    definition('runtime.self-check', 'Diagnostics self-check', 'final', (context) => {
      const results = context && typeof context.getResults === 'function' ? context.getResults() : [];
      const terminal = new Set(['pass', 'fail', 'skipped']);
      const complete = new Set(expectedCheckIds).size === expectedCheckIds.length
        && expectedCheckIds.every((id) => {
          const matches = results.filter((result) => result && result.id === id);
          return matches.length === 1 && terminal.has(matches[0].status);
        });
      return complete
        ? { status: 'pass', summary: 'All preceding runtime checks completed' }
        : { status: 'fail', summary: 'A preceding runtime check is incomplete', errorCode: 'RUNTIME_CHECK_INCOMPLETE' };
    })
  ];
}

module.exports = { createRuntimeChecks };
