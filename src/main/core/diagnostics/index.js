const { createRuntimeChecks } = require('./checks/runtime');
const { createStorageChecks } = require('./checks/storage');
const { createWindowsChecks } = require('./checks/windows');
const { createNetworkChecks } = require('./checks/network');
const { createProviderChecks } = require('./checks/providers');
const { createDiagnosticsController } = require('./controller');
const { createRunSnapshot } = require('./runner');

const RUNTIME_PREDECESSOR_IDS = Object.freeze([
  'runtime.versions',
  'runtime.windows-build',
  'runtime.renderer-build',
  'runtime.ipc-roundtrip',
  'runtime.window-references'
]);
const PHASES = new Set(['local', 'windows', 'remote', 'final']);
const SCHEDULER_CHANNELS = new Set(['balance', 'usage', 'quota', 'localLog']);
const SCHEDULER_GUIDES = Object.freeze({
  deepseek: 'deepseek-session',
  codex: 'codex-auth',
  kimi: 'kimi-auth'
});
const CONTROLLER_METHODS = Object.freeze(['start', 'copy', 'openGuide', 'dispose']);

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

function readDependency(source, key) {
  try {
    return source && (typeof source === 'object' || typeof source === 'function')
      ? Reflect.get(source, key)
      : undefined;
  } catch (_) {
    return undefined;
  }
}

function validatedController(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  const api = {};
  try {
    for (const method of CONTROLLER_METHODS) {
      const implementation = Reflect.get(value, method);
      if (typeof implementation !== 'function') return null;
      api[method] = implementation.bind(value);
    }
  } catch (_) {
    return null;
  }
  return api;
}

function assembleController(dependencies, checks) {
  const controllerDependencies = readDependency(dependencies, 'controller');
  const options = Object.create(
    controllerDependencies && typeof controllerDependencies === 'object'
      ? controllerDependencies
      : null
  );
  Object.defineProperty(options, 'checks', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: checks
  });
  const customFactory = readDependency(dependencies, 'createController');
  let api = null;
  if (typeof customFactory === 'function') {
    try {
      api = validatedController(customFactory(options));
    } catch (_) {
      api = null;
    }
  }
  if (!api) api = validatedController(createDiagnosticsController(options));
  return Object.assign({}, api, { checks: Object.freeze(checks.slice()) });
}

function fallbackCheck(name, guideId = 'app-runtime', phase = 'local') {
  return {
    id: `assembly.${name}`,
    group: 'Diagnostics',
    title: 'Diagnostics dependency',
    guideId,
    phase,
    timeoutMs: 3000,
    run: () => ({
      status: 'fail',
      summary: 'A diagnostics dependency is unavailable',
      errorCode: 'DIAGNOSTICS_DEPENDENCY_UNAVAILABLE'
    })
  };
}

function validDefinition(definition) {
  return definition && typeof definition === 'object'
    && typeof ownValue(definition, 'id') === 'string'
    && /^[a-z][a-z0-9.-]{0,63}$/.test(ownValue(definition, 'id'))
    && typeof ownValue(definition, 'group') === 'string'
    && typeof ownValue(definition, 'title') === 'string'
    && typeof ownValue(definition, 'guideId') === 'string'
    && ownValue(definition, 'guideId').length > 0
    && PHASES.has(ownValue(definition, 'phase'))
    && typeof ownValue(definition, 'run') === 'function';
}

function invokeFactory(name, factory, dependencies, guideId, phase) {
  try {
    const checks = factory(dependencies);
    if (!Array.isArray(checks) || checks.length === 0 || checks.some((check) => !validDefinition(check))) {
      throw new TypeError('Invalid diagnostics factory output');
    }
    return checks.slice();
  } catch (_) {
    return [fallbackCheck(name, guideId, phase)];
  }
}

function readSchedulerSnapshot(scheduler) {
  try {
    const snapshot = scheduler && typeof scheduler.getSnapshot === 'function' ? scheduler.getSnapshot() : [];
    return Array.isArray(snapshot) ? snapshot : [];
  } catch (_) {
    return [];
  }
}

function schedulerErrorCategory(value) {
  if (typeof value !== 'string' || !value) return 'healthy';
  if (/unauthoriz|forbidden|\b401\b|\b403\b|expired|invalid[ -]?token|auth/i.test(value)) return 'authentication';
  if (/timeout|timed?\s*out|ETIMEDOUT/i.test(value)) return 'timeout';
  if (/proxy|tunnel/i.test(value)) return 'proxy';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(value)) return 'dns';
  if (/ECONN|ENETUNREACH|EHOSTUNREACH|socket|network/i.test(value)) return 'network';
  if (/\bHTTP\s+[1-5]\d{2}\b/i.test(value)) return 'http';
  return 'unknown';
}

function schedulerSummary(category) {
  return {
    healthy: 'Scheduler has no recorded provider error',
    authentication: 'Scheduler observed an authentication failure',
    timeout: 'Scheduler observed a request timeout',
    proxy: 'Scheduler observed a proxy failure',
    dns: 'Scheduler observed a DNS failure',
    network: 'Scheduler observed a network failure',
    http: 'Scheduler observed an HTTP failure',
    unknown: 'Scheduler observed a provider failure'
  }[category];
}

function safeSchedulerMetadata(source) {
  const authStatus = ownValue(source, 'authStatus');
  const lastErrorChannel = ownValue(source, 'lastErrorChannel');
  const lastFailedAt = ownValue(source, 'lastFailedAt');
  const lastFetchedAt = ownValue(source, 'lastFetchedAt');
  return {
    authStatus: ['ok', 'missing', 'expired'].includes(authStatus) ? authStatus : 'unknown',
    lastErrorChannel: SCHEDULER_CHANNELS.has(lastErrorChannel) ? lastErrorChannel : null,
    lastFailedAt: Number.isFinite(lastFailedAt) ? lastFailedAt : null,
    lastFetchedAt: Number.isFinite(lastFetchedAt) ? lastFetchedAt : null,
    stale: ownValue(source, 'stale') === true
  };
}

function createSchedulerChecks(scheduler) {
  const ids = [];
  for (const source of readSchedulerSnapshot(scheduler)) {
    const id = ownValue(source, 'id');
    if (typeof id === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.map((providerId) => ({
    id: `scheduler.${providerId}`,
    group: 'Scheduler',
    title: 'Scheduler provider observation',
    guideId: SCHEDULER_GUIDES[providerId] || 'app-runtime',
    phase: 'final',
    timeoutMs: 3000,
    run: () => {
      const source = readSchedulerSnapshot(scheduler).find((item) => ownValue(item, 'id') === providerId) || {};
      const category = schedulerErrorCategory(ownValue(source, 'lastError'));
      return category === 'healthy'
        ? { status: 'pass', summary: schedulerSummary(category), metadata: safeSchedulerMetadata(source) }
        : {
            status: 'fail',
            summary: schedulerSummary(category),
            errorCode: 'SCHEDULER_OBSERVED_FAILURE',
            metadata: safeSchedulerMetadata(source)
          };
    }
  }));
}

function fallbackSelfCheck(expectedCheckIds) {
  return {
    id: 'runtime.self-check',
    group: 'Runtime',
    title: 'Diagnostics self-check',
    guideId: 'app-runtime',
    phase: 'final',
    timeoutMs: 3000,
    run(context) {
      const results = context && typeof context.getResults === 'function' ? context.getResults() : [];
      const terminal = new Set(['pass', 'fail', 'skipped']);
      const complete = expectedCheckIds.every((id) => {
        const matches = results.filter((result) => result && result.id === id);
        return matches.length === 1 && terminal.has(matches[0].status);
      });
      return complete
        ? { status: 'pass', summary: 'All preceding diagnostics checks completed' }
        : { status: 'fail', summary: 'A preceding diagnostics check is incomplete', errorCode: 'RUNTIME_CHECK_INCOMPLETE' };
    }
  };
}

function createDiagnostics(dependencies = {}) {
  const deps = dependencies && typeof dependencies === 'object' ? dependencies : {};
  const factories = deps.factories && typeof deps.factories === 'object' ? deps.factories : {};
  const storage = invokeFactory('storage', factories.storage || createStorageChecks, deps.storage || {}, 'storage-config', 'local');
  const windows = invokeFactory('windows', factories.windows || createWindowsChecks, deps.windows || {}, 'windows-acrylic', 'windows');
  const network = invokeFactory('network', factories.network || createNetworkChecks, deps.network || {}, 'network-proxy', 'remote');
  const providers = invokeFactory('providers', factories.providers || createProviderChecks, deps.providers || {}, 'app-runtime', 'remote');
  const scheduler = createSchedulerChecks(deps.scheduler);
  const expectedCheckIds = RUNTIME_PREDECESSOR_IDS.concat(
    storage.map((check) => check.id),
    windows.map((check) => check.id),
    network.map((check) => check.id),
    providers.map((check) => check.id),
    scheduler.map((check) => check.id)
  );
  const runtime = invokeFactory(
    'runtime',
    factories.runtime || createRuntimeChecks,
    Object.assign({}, deps.runtime || {}, { expectedCheckIds }),
    'app-runtime',
    'local'
  );
  let runtimePredecessors = runtime.filter((check) => check.id !== 'runtime.self-check');
  let selfCheck = runtime.find((check) => check.id === 'runtime.self-check');
  if (runtimePredecessors.map((check) => check.id).join('\n') !== RUNTIME_PREDECESSOR_IDS.join('\n')) {
    runtimePredecessors = [fallbackCheck('runtime')];
    const fallbackExpected = runtimePredecessors.concat(storage, windows, network, providers, scheduler).map((check) => check.id);
    selfCheck = fallbackSelfCheck(fallbackExpected);
  } else if (!selfCheck || selfCheck.phase !== 'final') {
    selfCheck = fallbackSelfCheck(expectedCheckIds);
  }

  const checks = runtimePredecessors.concat(storage, windows, network, providers, scheduler, selfCheck);
  try {
    createRunSnapshot('diagnostics-assembly-contract', checks);
  } catch (_) {
    const safeChecks = [fallbackCheck('registry'), fallbackSelfCheck(['assembly.registry'])];
    return assembleController(deps, safeChecks);
  }

  return assembleController(deps, checks);
}

module.exports = { createDiagnostics, schedulerErrorCategory };
