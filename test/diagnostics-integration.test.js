const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { types: utilTypes } = require('node:util');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const { createDiagnostics } = require('../src/main/core/diagnostics');
const { projectDiagnosticsTheme } = require('../src/main/core/diagnostics/theme');
const { collectWindowsCapabilities } = require('../src/main/core/diagnostics/checks/windows');
const { validateEncryptionKey } = require('../src/main/core/encryption-key');
const { normalizeStoredProxyValue } = require('../src/main/core/proxy-settings');

const PROVIDER_CHECK_IDS = Object.freeze([
  'deepseek.api-key',
  'deepseek.session',
  'codex.auth',
  'codex.sessions',
  'codex.local-log',
  'codex.quota',
  'kimi.auth',
  'kimi.sessions',
  'kimi.local-log',
  'kimi.quota'
]);

const EXPECTED_CHECK_IDS = Object.freeze([
  'runtime.versions',
  'runtime.windows-build',
  'runtime.renderer-build',
  'runtime.ipc-roundtrip',
  'runtime.window-references',
  'storage.user-data-access',
  'storage.store-initialized',
  'storage.config-readable',
  'storage.temp-write',
  'storage.encryption-state',
  'storage.settings-schema',
  'windows.platform-build',
  'windows.dwm-composition',
  'windows.koffi-runtime',
  'windows.native-libraries',
  'windows.ffi-bindings',
  'windows.native-handle',
  'windows.acrylic-accent',
  'windows.electron-acrylic',
  'windows.gpu',
  'windows.transparency-settings',
  'network.proxy-config',
  'network.system-proxy',
  'network.custom-proxy',
  'network.deepseek-api',
  'network.deepseek-platform',
  'network.codex',
  'network.kimi',
  ...PROVIDER_CHECK_IDS,
  'scheduler.deepseek',
  'scheduler.codex',
  'scheduler.kimi',
  'runtime.self-check'
]);

function loadDedicatedDiagnosticsBridge() {
  let diagnosticsBridge;
  const ipcRenderer = {
    invoke() { return Promise.resolve(); },
    send() {},
    on() {},
    removeListener() {}
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'diagnostics-preload.js'), 'utf8');
  vm.runInNewContext(source, {
    require(name) {
      if (name !== 'electron') throw new Error(`Unexpected preload import: ${name}`);
      return {
        ipcRenderer,
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'diagnosticsApi');
            diagnosticsBridge = value;
          }
        }
      };
    },
    Object,
    Promise
  }, { filename: 'diagnostics-preload.js' });
  return diagnosticsBridge;
}

function successfulNetConnect() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => {
    socket.destroyed = true;
  };
  setImmediate(() => {
    if (!socket.destroyed) socket.emit('connect');
  });
  return socket;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createStoreAudit(values) {
  const reads = [];
  const violations = [];
  const allowedKeys = new Set(Object.keys(values));

  function reject(kind, target) {
    violations.push({ kind, target });
    throw new Error(`diagnostics safety audit rejected ${kind}: ${target}`);
  }

  const store = new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === 'get') {
        return (key) => {
          reads.push(key);
          if (!allowedKeys.has(key)) return reject('store-read', key);
          return values[key];
        };
      }
      if (typeof property === 'string') {
        return (...args) => reject('store-mutation', `${property}:${String(args[0] ?? '')}`);
      }
      return undefined;
    },
    set(_target, property) {
      return reject('store-property-set', String(property));
    },
    defineProperty(_target, property) {
      return reject('store-property-define', String(property));
    },
    deleteProperty(_target, property) {
      return reject('store-property-delete', String(property));
    }
  });

  return { store, reads, violations };
}

function createFsAudit({ readRoots, readFiles, userDataDir }) {
  const canonicalRoots = readRoots.map((target) => path.resolve(target));
  const canonicalFiles = new Set(readFiles.map((target) => path.resolve(target)));
  const canonicalUserData = path.resolve(userDataDir);
  const reads = [];
  const violations = [];
  const descriptors = new Map();
  const tempLifecycles = new Map();

  function reject(kind, target) {
    violations.push({ kind, target: String(target) });
    throw new Error(`diagnostics safety audit rejected ${kind}: ${String(target)}`);
  }

  function canonical(target, kind) {
    if (typeof target !== 'string' || !target) return reject(kind, '<invalid-path>');
    return path.resolve(target);
  }

  function isWithin(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  function allowRead(method, target) {
    const resolved = canonical(target, 'fs-read');
    if (!canonicalFiles.has(resolved) && !canonicalRoots.some((root) => isWithin(root, resolved))) {
      return reject('fs-read-outside-fixtures', resolved);
    }
    reads.push({ method, target: resolved });
    return resolved;
  }

  function tempForDescriptor(fd, method) {
    const descriptor = descriptors.get(fd);
    if (!descriptor || descriptor.kind !== 'temp') return reject(`fs-${method}-unapproved-fd`, fd);
    return descriptor.lifecycle;
  }

  const approved = {
    constants: fs.constants,
    accessSync(target, mode) {
      return fs.accessSync(allowRead('accessSync', target), mode);
    },
    readFileSync(target, ...args) {
      return fs.readFileSync(allowRead('readFileSync', target), ...args);
    },
    readdirSync(target, ...args) {
      return fs.readdirSync(allowRead('readdirSync', target), ...args);
    },
    lstatSync(target, ...args) {
      return fs.lstatSync(allowRead('lstatSync', target), ...args);
    },
    statSync(target, ...args) {
      return fs.statSync(allowRead('statSync', target), ...args);
    },
    openSync(target, flags, mode) {
      const resolved = canonical(target, 'fs-open');
      if (flags === 'r') {
        allowRead('openSync:r', resolved);
        const fd = fs.openSync(resolved, flags, mode);
        descriptors.set(fd, { kind: 'read', target: resolved });
        return fd;
      }
      const name = path.basename(resolved);
      if (flags !== 'wx'
        || path.dirname(resolved) !== canonicalUserData
        || !/^\.diagnostics-[0-9a-f]{24}\.tmp$/.test(name)
        || tempLifecycles.has(resolved)) {
        return reject('fs-open-mutation', `${resolved}:${flags}`);
      }
      const lifecycle = { target: resolved, events: ['open'], removed: false };
      const fd = fs.openSync(resolved, flags, mode);
      tempLifecycles.set(resolved, lifecycle);
      descriptors.set(fd, { kind: 'temp', lifecycle });
      return fd;
    },
    readSync(fd, ...args) {
      const descriptor = descriptors.get(fd);
      if (!descriptor || descriptor.kind !== 'read') return reject('fs-read-unapproved-fd', fd);
      return fs.readSync(fd, ...args);
    },
    writeSync(fd, value, ...args) {
      const lifecycle = tempForDescriptor(fd, 'write');
      if (lifecycle.events.join(',') !== 'open'
        || args.length !== 0
        || !Buffer.isBuffer(value)
        || !value.equals(Buffer.from('ok'))) {
        return reject('fs-temp-write-lifecycle', lifecycle.target);
      }
      const written = fs.writeSync(fd, value);
      lifecycle.events.push('write');
      return written;
    },
    fsyncSync(fd) {
      const lifecycle = tempForDescriptor(fd, 'fsync');
      if (lifecycle.events.join(',') !== 'open,write') {
        return reject('fs-temp-fsync-lifecycle', lifecycle.target);
      }
      const result = fs.fsyncSync(fd);
      lifecycle.events.push('fsync');
      return result;
    },
    closeSync(fd) {
      const descriptor = descriptors.get(fd);
      if (!descriptor) return reject('fs-close-unapproved-fd', fd);
      if (descriptor.kind === 'read') {
        const result = fs.closeSync(fd);
        descriptors.delete(fd);
        return result;
      }
      const { lifecycle } = descriptor;
      if (lifecycle.events.join(',') !== 'open,write,fsync') {
        return reject('fs-temp-close-lifecycle', lifecycle.target);
      }
      const result = fs.closeSync(fd);
      descriptors.delete(fd);
      lifecycle.events.push('close');
      return result;
    },
    rmSync(target, options) {
      const resolved = canonical(target, 'fs-remove');
      const lifecycle = tempLifecycles.get(resolved);
      if (!lifecycle
        || lifecycle.removed
        || lifecycle.events.join(',') !== 'open,write,fsync,close'
        || !options
        || options.force !== true
        || Object.keys(options).some((key) => key !== 'force')) {
        return reject('fs-remove-mutation', resolved);
      }
      const result = fs.rmSync(resolved, options);
      lifecycle.events.push('remove');
      lifecycle.removed = true;
      return result;
    }
  };

  const auditedFs = new Proxy(approved, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      if (property === 'then') return undefined;
      if (property === 'promises') {
        return new Proxy({}, {
          get(_promises, method) {
            if (method === 'then') return undefined;
            return (...args) => reject('fs-unapproved-method', `promises.${String(method)}:${String(args[0] ?? '')}`);
          }
        });
      }
      if (typeof property === 'string') {
        return (...args) => reject('fs-unapproved-method', `${property}:${String(args[0] ?? '')}`);
      }
      return undefined;
    }
  });

  return { fs: auditedFs, reads, violations, tempLifecycles };
}

function findDiagnosticTempFiles(userDataDir) {
  return fs.readdirSync(userDataDir).filter((name) => /^\.diagnostics-.*\.tmp$/.test(name));
}

function createRemoteBoundary() {
  const calls = [];
  const errors = [];
  const blockers = new Set();
  const overlapReleased = deferred();
  let overlapEntries = 0;
  let overlapDone = false;
  let nextBlock = null;
  let active = 0;
  let peak = 0;
  const idleWaiters = new Set();

  function signalFor(call) {
    return call && call.timeoutOptions && call.timeoutOptions.signal;
  }

  function waitForGate(gate, label, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      };
      const settle = (method, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        method(value);
      };
      const onAbort = () => {
        const error = new Error('diagnostics remote fixture aborted');
        error.code = 'DIAGNOSTIC_ABORTED';
        settle(reject, error);
      };
      if (signal && signal.aborted) {
        onAbort();
        return;
      }
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      Promise.resolve(gate).then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error)
      );
      timer = setTimeout(() => settle(reject, new Error(`${label} timed out after 5000ms`)), 5000);
    });
  }

  async function invoke(call, result) {
    calls.push(call);
    active += 1;
    peak = Math.max(peak, active);
    const signal = signalFor(call);
    try {
      if (!overlapDone) {
        overlapEntries += 1;
        if (overlapEntries >= 3) {
          overlapDone = true;
          overlapReleased.resolve();
        }
        try {
          await waitForGate(overlapReleased.promise, 'remote overlap barrier', signal);
        } catch (error) {
          if (error.code !== 'DIAGNOSTIC_ABORTED') errors.push(error.message);
          throw error;
        }
      }
      if (nextBlock && !nextBlock.claimed) {
        nextBlock.claimed = true;
        nextBlock.started.resolve();
        try {
          await waitForGate(nextBlock.released.promise, 'blocked remote release', signal);
        } catch (error) {
          if (error.code !== 'DIAGNOSTIC_ABORTED') errors.push(error.message);
          throw error;
        }
      }
      return result;
    } finally {
      active -= 1;
      if (active === 0) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    }
  }

  const boundary = {
    calls,
    errors,
    active: () => active,
    peak: () => peak,
    overlapEntries: () => overlapEntries,
    waitForIdle() {
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.add(resolve));
    },
    blockNext() {
      const started = deferred();
      const released = deferred();
      nextBlock = { started, released, claimed: false };
      const blocker = {
        started: started.promise,
        release() { released.resolve(); }
      };
      blockers.add(blocker);
      return blocker;
    },
    releaseAll() {
      overlapDone = true;
      overlapReleased.resolve();
      for (const blocker of blockers) blocker.release();
    },
    async httpGet(url, headers = {}, proxyInput, timeoutOptions) {
      const authorization = Object.prototype.hasOwnProperty.call(headers, 'Authorization');
      const type = authorization
        ? url.includes('chatgpt.com') ? 'provider.codex-quota' : 'provider.kimi-quota'
        : 'network.probe';
      return invoke({ type, url, headers: Object.assign({}, headers), proxyInput, timeoutOptions }, { ok: true });
    },
    async fetchBalance(key, options) {
      return invoke({
        type: 'provider.deepseek-api-key',
        url: 'https://api.deepseek.com/user/balance',
        key,
        options
      }, { available: true });
    }
  };
  boundary.UsageFetcher = class UsageFetcher {
    async fetchUsageAmount(token, month, year, options) {
      return invoke({
        type: 'provider.deepseek-session',
        url: 'https://platform.deepseek.com/usage',
        token,
        month,
        year,
        options
      }, { aggregate: { totalTokens: 1 } });
    }
  };
  return boundary;
}

function createRendererWindow(progressEvents) {
  let closed = false;
  let sendsAfterClose = 0;
  const waiters = new Set();
  const webContents = {
    id: 901,
    isDestroyed: () => closed,
    send(channel, payload) {
      if (closed) {
        sendsAfterClose += 1;
        throw new Error('renderer is closed');
      }
      assert.equal(channel, 'diagnostics:progress');
      progressEvents.push(payload);
      for (const waiter of Array.from(waiters)) {
        if (waiter.predicate(payload)) {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(payload);
        }
      }
    }
  };
  return {
    webContents,
    isDestroyed: () => closed,
    close() { closed = true; },
    dispose() {
      closed = true;
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('diagnostics renderer disposed'));
      }
      waiters.clear();
    },
    sendsAfterClose: () => sendsAfterClose,
    waitFor(predicate) {
      const existing = progressEvents.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('timed out waiting for diagnostics progress'));
        }, 5000);
        waiters.add(waiter);
      });
    }
  };
}

function createWindowsBoundary(privateGpuValue) {
  const calls = [];
  const violations = [];
  const systemMutations = [];
  const lifecycle = {
    created: false,
    nativeHandleRead: false,
    accentApplied: false,
    materialApplied: false,
    accentCleared: false,
    destroyed: false
  };
  const nativeHandle = Buffer.alloc(8, 1);

  function reject(kind, target, systemMutation = false) {
    const violation = { kind, target: String(target) };
    violations.push(violation);
    if (systemMutation) systemMutations.push(violation);
    throw new Error(`diagnostics safety audit rejected ${kind}: ${String(target)}`);
  }

  function isSystemMutationName(property) {
    return /registry|system|setting|write|set|delete|remove|update|mutat/i.test(String(property));
  }

  function facade(label, members) {
    return new Proxy(Object.create(null), {
      get(_target, property) {
        if (Object.prototype.hasOwnProperty.call(members, property)) return members[property];
        const mutation = isSystemMutationName(property);
        return reject(mutation ? 'windows-system-mutation' : 'windows-unapproved-access', `${label}.${String(property)}`, mutation);
      },
      set(_target, property) {
        return reject('windows-system-mutation', `${label}.${String(property)}=`, true);
      },
      defineProperty(_target, property) {
        return reject('windows-system-mutation', `${label}.define:${String(property)}`, true);
      },
      deleteProperty(_target, property) {
        return reject('windows-system-mutation', `${label}.delete:${String(property)}`, true);
      }
    });
  }

  function requireCall(condition, label, systemMutation = false) {
    if (!condition) reject(
      systemMutation ? 'windows-system-mutation' : 'windows-call-contract',
      label,
      systemMutation
    );
  }

  let accentApi;
  accentApi = facade('accentApi', {
    enable: (...args) => reject('windows-system-mutation', `accentApi.enable:${args.length}`, true),
    disable: (...args) => reject('windows-system-mutation', `accentApi.disable:${args.length}`, true)
  });

  function nativeFunction(libraryName, signature) {
    if (signature === 'long DwmIsCompositionEnabled(int *enabled)') {
      let called = false;
      return (enabled) => {
        requireCall(!called && Buffer.isBuffer(enabled) && enabled.length === 4, 'DwmIsCompositionEnabled');
        called = true;
        calls.push(['native-read', libraryName, 'DwmIsCompositionEnabled']);
        enabled.writeInt32LE(1);
        return 0;
      };
    }
    if (signature === 'bool SetWindowCompositionAttribute(uintptr_t hwnd, const void *data)') {
      return (...args) => reject(
        'windows-system-mutation',
        `SetWindowCompositionAttribute:${args.length}`,
        true
      );
    }
    return reject('windows-unapproved-access', `${libraryName}.func:${signature}`);
  }

  const expectedLibraries = new Set(['user32.dll', 'dwmapi.dll', 'gdi32.dll']);
  const loadedLibraries = new Set();
  const libraries = new Map();
  for (const name of expectedLibraries) {
    libraries.set(name, facade(`koffi.library:${name}`, {
      func(signature) {
        const expected = name === 'user32.dll'
          ? 'bool SetWindowCompositionAttribute(uintptr_t hwnd, const void *data)'
          : name === 'dwmapi.dll'
            ? 'long DwmIsCompositionEnabled(int *enabled)'
            : null;
        requireCall(signature === expected, `${name}.func:${signature}`);
        calls.push(['func', name, signature]);
        return nativeFunction(name, signature);
      }
    }));
  }

  const koffi = facade('koffi', {
    load(name) {
      requireCall(expectedLibraries.has(name), `koffi.load:${name}`);
      loadedLibraries.add(name);
      calls.push(['load', name]);
      return libraries.get(name);
    }
  });

  let temporaryWindow;
  temporaryWindow = facade('BrowserWindow.instance', {
    getNativeWindowHandle(...args) {
      requireCall(lifecycle.created && !lifecycle.nativeHandleRead && !lifecycle.destroyed && args.length === 0, 'getNativeWindowHandle');
      lifecycle.nativeHandleRead = true;
      calls.push(['native-handle']);
      return nativeHandle;
    },
    setBackgroundMaterial(material) {
      requireCall(
        lifecycle.nativeHandleRead && !lifecycle.materialApplied && !lifecycle.destroyed && material === 'acrylic',
        `setBackgroundMaterial:${material}`,
        true
      );
      lifecycle.materialApplied = true;
      calls.push(['material', material]);
    },
    destroy(...args) {
      requireCall(
        lifecycle.created && lifecycle.accentCleared && !lifecycle.destroyed && args.length === 0,
        'BrowserWindow.destroy',
        true
      );
      lifecycle.destroyed = true;
      calls.push(['destroy']);
    }
  });

  const BrowserWindow = new Proxy(function BrowserWindow() {}, {
    construct(_target, args) {
      if (lifecycle.destroyed) {
        for (const key of Object.keys(lifecycle)) lifecycle[key] = false;
      }
      const options = args[0];
      requireCall(
        args.length === 1
          && options
          && Object.keys(options).length === 4
          && options.show === false
          && options.width === 1
          && options.height === 1
          && options.frame === false
          && !lifecycle.created,
        'BrowserWindow.create',
        true
      );
      lifecycle.created = true;
      calls.push(['create', Object.assign({}, options)]);
      return temporaryWindow;
    },
    apply() {
      return reject('windows-call-contract', 'BrowserWindow without new');
    },
    get(_target, property) {
      return reject('windows-unapproved-access', `BrowserWindow.${String(property)}`);
    }
  });

  const app = facade('electron.app', {
    getGPUFeatureStatus(...args) {
      requireCall(args.length === 0, 'app.getGPUFeatureStatus');
      calls.push(['gpu-features']);
      return { gpu_compositing: 'enabled' };
    },
    async getGPUInfo(level, ...rest) {
      requireCall(level === 'basic' && rest.length === 0, `app.getGPUInfo:${level}`);
      calls.push(['gpu-info', level]);
      return {
        auxAttributes: { amdSwitchable: 0, optimus: 1 },
        gpuDevice: [{ driver_version: privateGpuValue }]
      };
    }
  });

  const dependencies = facade('windows.dependencies', {
    platform: 'win32',
    release: '10.0.19045',
    getWindowsBuild: undefined,
    os: undefined,
    koffi,
    BrowserWindow,
    createAccentApi(koffiInput, ...rest) {
      requireCall(koffiInput === koffi && rest.length === 0, 'createAccentApi');
      calls.push(['create-accent-api']);
      return accentApi;
    },
    applyAccent(windowInput, options, ...rest) {
      requireCall(
        windowInput === temporaryWindow
          && options
          && options.api === accentApi
          && options.platform === 'win32'
          && rest.length === 0
          && lifecycle.nativeHandleRead
          && !lifecycle.accentApplied
          && !lifecycle.destroyed,
        'applyAccent',
        true
      );
      lifecycle.accentApplied = true;
      calls.push(['apply-accent']);
      return true;
    },
    verifyAccent: undefined,
    clearAccent(windowInput, options, ...rest) {
      requireCall(
        windowInput === temporaryWindow
          && options
          && options.api === accentApi
          && options.platform === 'win32'
          && rest.length === 0
          && lifecycle.created
          && !lifecycle.accentCleared
          && !lifecycle.destroyed,
        'clearAccent',
        true
      );
      lifecycle.accentCleared = true;
      calls.push(['clear-accent']);
      return true;
    },
    app,
    then: undefined
  });

  return { dependencies, calls, violations, systemMutations, lifecycle };
}

function terminalResultsForRun(events, runId) {
  const terminal = new Set(['pass', 'fail', 'skipped']);
  const byId = new Map();
  for (const event of events) {
    if (event.runId === runId && terminal.has(event.check.status)) byId.set(event.check.id, event.check);
  }
  return EXPECTED_CHECK_IDS.map((id) => byId.get(id)).filter(Boolean);
}

function normalizedSensitiveText(value) {
  return value.replace(/[\\/]+/g, '/').toLowerCase();
}

function collectOwnStrings(value, label, output = [], seen = new Set(), trail = '$') {
  if (typeof value === 'string') {
    output.push({ trail, value });
    return output;
  }
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return output;
  assert.equal(utilTypes.isProxy(value), false, `${label} contains a proxy at ${trail}`);
  if (seen.has(value)) return output;
  seen.add(value);

  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    assert.fail(`${label} reflection failed at ${trail}: ${error && error.name ? error.name : 'Error'}`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    const propertyTrail = `${trail}.${String(key)}`;
    if (typeof key === 'string') output.push({ trail: `${propertyTrail}#key`, value: key });
    assert.equal(
      Object.prototype.hasOwnProperty.call(descriptor, 'value'),
      true,
      `${label} contains an accessor at ${propertyTrail}`
    );
    collectOwnStrings(descriptor.value, label, output, seen, propertyTrail);
  }
  return output;
}

function assertSensitivePayloadAbsent(payload, forbidden, label) {
  const strings = collectOwnStrings(payload, label);
  for (const entry of forbidden) {
    const needle = normalizedSensitiveText(entry.value);
    for (const candidate of strings) {
      assert.equal(
        normalizedSensitiveText(candidate.value).includes(needle),
        false,
        `${label} leaked ${entry.name} at ${candidate.trail}`
      );
    }
  }
}

test('diagnostics safety oracles reject adversarial side effects and fixture-root escapes before touching disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-oracle-'));
  try {
    const userDataDir = path.join(root, 'user-data');
    fs.mkdirSync(userDataDir);
    const storeAudit = createStoreAudit({ 'data.historyDays': 7 });
    const fsAudit = createFsAudit({ readRoots: [root], readFiles: [], userDataDir });
    const windowsAudit = createWindowsBoundary('private-gpu');

    assert.throws(() => windowsAudit.dependencies.registry.setValue('Transparency', 0), /windows-system-mutation/);
    assert.throws(() => windowsAudit.dependencies.shell, /windows-unapproved-access/);
    assert.equal(windowsAudit.systemMutations.length, 1);
    assert.equal(windowsAudit.violations.length, 2);
    assert.throws(() => storeAudit.store.set('providers.codex.cursor', 'advanced'), /store-mutation/);
    assert.throws(() => storeAudit.store.rotateCredentials('secret'), /store-mutation/);
    assert.throws(() => storeAudit.store.get('providers.codex.migration'), /store-read/);
    assert.throws(() => { storeAudit.store.cursor = 'advanced'; }, /store-property-set/);
    assert.throws(() => { delete storeAudit.store.cursor; }, /store-property-delete/);
    assert.throws(() => fsAudit.fs.writeFileSync(path.join(root, 'rewrite'), 'bytes'), /fs-unapproved-method/);
    assert.throws(() => fsAudit.fs.renameSync(path.join(root, 'from'), path.join(root, 'to')), /fs-unapproved-method/);
    assert.throws(() => fsAudit.fs.promises.writeFile(path.join(root, 'async-rewrite'), 'bytes'), /fs-unapproved-method/);
    assert.throws(() => fsAudit.fs.openSync(path.join(userDataDir, 'not-diagnostic.tmp'), 'wx'), /fs-open-mutation/);
    assert.throws(() => fsAudit.fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json')), /fs-read-outside-fixtures/);
    assert.throws(() => assertSensitivePayloadAbsent(
      `safe-prefix ${root} safe-suffix`,
      [{ name: 'temporary-root', value: root }],
      'adversarial output'
    ), /temporary-root/);
    assert.throws(() => assertSensitivePayloadAbsent(
      { runId: 'adversarial-progress', check: { metadata: { homePath: root } } },
      [{ name: 'windows-temp-root', value: root }],
      'adversarial progress'
    ), /windows-temp-root/);
    assert.throws(() => assertSensitivePayloadAbsent(
      { nested: { header: 'aUtHoRiZaTiOn' } },
      [{ name: 'authorization-header', value: 'Authorization' }],
      'case-insensitive adversarial progress'
    ), /authorization-header/);
    assert.throws(() => assertSensitivePayloadAbsent(
      new Proxy({}, {}),
      [],
      'proxy adversarial progress'
    ), /contains a proxy/);
    const accessorPayload = {};
    Object.defineProperty(accessorPayload, 'secret', { get() { throw new Error('must not execute'); } });
    assert.throws(() => assertSensitivePayloadAbsent(
      accessorPayload,
      [],
      'accessor adversarial progress'
    ), /contains an accessor/);
    assert.equal(storeAudit.violations.length, 5);
    assert.equal(fsAudit.violations.length, 5);
    assert.deepEqual(fs.readdirSync(userDataDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assembled diagnostics preserves private state, cleans temporary files, and stops stale closed-window sends', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-integration-'));
  let blockedRemote = null;
  let diagnostics = null;
  let remote = null;
  let rendererWindow = null;
  try {
    const nowMs = 2_000_000_000_000;
    const expectedTheme = { darkMode: 'acrylic-dark', followSystemTheme: false };
    const themeProjection = projectDiagnosticsTheme({
      window: expectedTheme,
      providers: { codex: { localLogRoot: 'C:\\Users\\Private\\.codex' } },
      localLogCursors: { private: 1 }
    });
    assert.deepEqual(themeProjection, { window: expectedTheme });
    const diagnosticsBridge = loadDedicatedDiagnosticsBridge();
    assert.equal(diagnosticsBridge.settingsSave, undefined);

    let unsupportedWindowsNativeTouches = 0;
    const unsupportedWindows = {
      platform: 'win32',
      release: 'unknown-build',
      app: {
        getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }),
        getGPUInfo: async () => ({ auxAttributes: {} })
      }
    };
    for (const key of ['koffi', 'BrowserWindow', 'createAccentApi', 'applyAccent', 'clearAccent']) {
      Object.defineProperty(unsupportedWindows, key, {
        enumerable: true,
        get() {
          unsupportedWindowsNativeTouches += 1;
          throw new Error(`unsupported build touched ${key}`);
        }
      });
    }
    const unsupportedSnapshot = await collectWindowsCapabilities(unsupportedWindows);
    assert.equal(unsupportedSnapshot.platformBuildSupported, false);
    assert.equal(unsupportedWindowsNativeTouches, 0);

    const userDataDir = path.join(root, 'user-data');
    const buildDir = path.join(root, 'build-inputs');
    const codexSessionsRoot = path.join(root, 'codex-sessions');
    const kimiSessionsRoot = path.join(root, 'kimi-sessions');
    const codexAuthPath = path.join(root, 'codex-auth-fixture.json');
    const kimiCredPath = path.join(root, 'kimi-credential-fixture.json');
    const codexSessionPath = path.join(codexSessionsRoot, 'run', 'rollout-private-session-fixture-98aa.jsonl');
    const kimiSessionPath = path.join(kimiSessionsRoot, 'private-session-fixture-bdc1', 'wire.jsonl');
    const sentinels = {
      deepseekApiKey: 'deepseek-secret-fixture-4f91',
      deepseekSession: 'deepseek-session-secret-fixture-31c2',
      codexAccess: 'codex-access-secret-fixture-9a77',
      codexRefresh: 'codex-refresh-secret-fixture-a814',
      codexAccount: 'codex-account-secret-fixture-0ce3',
      kimiAccess: 'kimi-access-secret-fixture-61d0',
      kimiRefresh: 'kimi-refresh-secret-fixture-772b',
      codexLog: 'codex-log-secret-fixture-98aa',
      kimiLog: 'kimi-log-secret-fixture-bdc1',
      gpu: 'gpu-driver-secret-fixture-572e',
      scheduler: 'scheduler-error-secret-fixture-28d4',
      stack: 'DIAGNOSTICS_STACK_SENTINEL_741c'
    };

    fs.mkdirSync(userDataDir);
    const collisionRandom = Buffer.alloc(12, 0xcd);
    const collisionPath = path.join(userDataDir, `.diagnostics-${collisionRandom.toString('hex')}.tmp`);
    const collisionBytesBefore = Buffer.from('assembled pre-existing collision bytes');
    fs.writeFileSync(collisionPath, collisionBytesBefore);
    fs.mkdirSync(buildDir);
    fs.mkdirSync(path.join(codexSessionsRoot, 'run'), { recursive: true });
    fs.mkdirSync(path.dirname(kimiSessionPath), { recursive: true });
    const buildPaths = {
      mainRenderer: path.join(buildDir, 'renderer.html'),
      preload: path.join(buildDir, 'preload.js'),
      diagnosticsPage: path.join(buildDir, 'diagnostics.html')
    };
    for (const target of Object.values(buildPaths)) fs.writeFileSync(target, 'fixture artifact');
    fs.writeFileSync(path.join(userDataDir, '.key'), 'ab'.repeat(32));
    fs.writeFileSync(path.join(userDataDir, 'config.json'), Buffer.from([0x00, 0xff, 0x10, 0x80]));
    fs.writeFileSync(codexAuthPath, JSON.stringify({
      tokens: {
        access_token: sentinels.codexAccess,
        refresh_token: sentinels.codexRefresh,
        account_id: sentinels.codexAccount
      }
    }));
    fs.writeFileSync(kimiCredPath, JSON.stringify({
      access_token: sentinels.kimiAccess,
      refresh_token: sentinels.kimiRefresh,
      expires_at: nowMs / 1000 + 3600
    }));
    fs.writeFileSync(codexSessionPath, JSON.stringify({
      type: 'event_msg',
      private: sentinels.codexLog,
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2, total_tokens: 3 } } }
    }) + '\n');
    fs.writeFileSync(kimiSessionPath, JSON.stringify({
      type: 'usage.record',
      private: sentinels.kimiLog,
      usage: { inputOther: 1, inputCacheRead: 2, output: 3 }
    }) + '\n');

    const codexBefore = fs.readFileSync(codexAuthPath);
    const kimiBefore = fs.readFileSync(kimiCredPath);
    const storeValues = {
      'data.historyDays': 7,
      'providers.proxyUrl': '',
      'providers.deepseek.apiKey': sentinels.deepseekApiKey,
      'providers.deepseek.sessionToken': sentinels.deepseekSession
    };
    const storeAudit = createStoreAudit(storeValues);
    const store = storeAudit.store;
    const fsAudit = createFsAudit({
      readRoots: [buildDir, userDataDir, codexSessionsRoot, kimiSessionsRoot],
      readFiles: [codexAuthPath, kimiCredPath],
      userDataDir
    });
    remote = createRemoteBoundary();
    const windowsAudit = createWindowsBoundary(sentinels.gpu);
    const progressEvents = [];
    rendererWindow = createRendererWindow(progressEvents);
    const copiedReports = [];
    const runIds = ['assembled-full-run', 'assembled-stale-run', 'assembled-replacement-run'];
    let nextRunId = 0;
    let tempRandomCalls = 0;
    const storageCrypto = {
      randomBytes(size) {
        assert.equal(size, 12);
        tempRandomCalls += 1;
        return tempRandomCalls === 1 ? collisionRandom : crypto.randomBytes(size);
      }
    };

    diagnostics = createDiagnostics({
      runtime: {
        versions: { app: '1.0.0', electron: '40.0.0', node: '22.0.0', chromium: '140.0.0' },
        platform: 'win32',
        arch: 'x64',
        release: '10.0.19045',
        buildPaths: Object.assign({ fs: fsAudit.fs }, buildPaths),
        getWindows: () => ({
          main: rendererWindow,
          settings: null,
          login: null,
          session: null,
          diagnostics: rendererWindow
        })
      },
      storage: {
        fs: fsAudit.fs,
        crypto: storageCrypto,
        path,
        userDataDir,
        store,
        validateEncryptionKey,
        normalizeStoredProxyValue
      },
      windows: windowsAudit.dependencies,
      network: { store, httpGet: remote.httpGet, netConnect: successfulNetConnect },
      providers: {
        fs: fsAudit.fs,
        store,
        now: () => nowMs,
        tokenExpiryMs: () => nowMs + 3600_000,
        codexAuthPath,
        codexSessionsRoot,
        kimiCredPath,
        kimiSessionsRoot,
        fetchBalance: remote.fetchBalance,
        UsageFetcher: remote.UsageFetcher,
        httpGet: remote.httpGet
      },
      scheduler: {
        getSnapshot: () => ['deepseek', 'codex', 'kimi'].map((id) => ({
          id,
          authStatus: 'ok',
          lastError: id === 'deepseek'
            ? `HTTP 503 ${sentinels.scheduler}\nError: ${sentinels.stack}\n    at fixture-stack-frame (${root}\\stack-source.js:17:9)`
            : null,
          lastErrorChannel: id === 'deepseek' ? 'usage' : null,
          lastFailedAt: id === 'deepseek' ? nowMs - 1000 : null,
          lastFetchedAt: nowMs,
          stale: false
        }))
      },
      controller: {
        randomUUID: () => runIds[nextRunId++],
        safeEnvironment: () => ({
          appVersion: '1.0.0',
          platform: 'win32',
          release: '10.0.19045',
          arch: 'x64',
          electron: '40.0.0',
          homeDir: root
        }),
        clipboard: { writeText: async (text) => copiedReports.push(text) }
      }
    });

    const assembledIds = diagnostics.checks.map((check) => check.id);
    assert.deepEqual(
      PROVIDER_CHECK_IDS.filter((id) => !assembledIds.includes(id)),
      [],
      'assembled registry is missing provider ids'
    );
    assert.deepEqual(assembledIds, EXPECTED_CHECK_IDS);

    const fullCompletion = rendererWindow.waitFor((event) => (
      event.runId === runIds[0]
      && event.check.id === 'runtime.self-check'
      && ['pass', 'fail', 'skipped'].includes(event.check.status)
    ));
    const fullRun = diagnostics.start(rendererWindow.webContents);
    assert.equal(fullRun.runId, runIds[0]);
    await withTimeout(fullCompletion, 5000, 'full diagnostics completion');

    const results = terminalResultsForRun(progressEvents, fullRun.runId);
    assert.equal(results.length, EXPECTED_CHECK_IDS.length);
    assert.equal(results.every((item) => ['pass', 'fail', 'skipped'].includes(item.status)), true);
    assert.equal(results.some((item) => item.status === 'fail'), true);
    assert.equal(results.filter((item) => item.status === 'fail').every((item) => item.guideId), true);
    assert.equal(results.find((item) => item.id === 'runtime.self-check').status, 'pass');
    assert.deepEqual(storeAudit.violations, []);
    assert.deepEqual(fsAudit.violations, []);
    assert.equal(fs.readFileSync(codexAuthPath).equals(codexBefore), true);
    assert.equal(fs.readFileSync(kimiCredPath).equals(kimiBefore), true);
    const collisionBytesAfter = fs.readFileSync(collisionPath);
    assert.equal(collisionBytesAfter.equals(collisionBytesBefore), true);
    assert.deepEqual(findDiagnosticTempFiles(userDataDir), [path.basename(collisionPath)]);

    const copied = await withTimeout(
      diagnostics.copy(rendererWindow.webContents, fullRun.runId),
      2000,
      'diagnostics report copy'
    );
    assert.equal(copied.ok, true);
    assert.equal(copiedReports.length, 1);
    const forbiddenOutput = [
      ...Object.entries(sentinels).map(([name, value]) => ({ name: `sentinel:${name}`, value })),
      { name: 'temporary-root', value: root },
      { name: 'temporary-root-forward-slashes', value: root.replace(/\\/g, '/') },
      { name: 'codex-credential-path', value: codexAuthPath },
      { name: 'kimi-credential-path', value: kimiCredPath },
      { name: 'codex-session-path', value: codexSessionPath },
      { name: 'kimi-session-path', value: kimiSessionPath },
      { name: 'codex-session-filename', value: path.basename(codexSessionPath) },
      { name: 'kimi-session-filename', value: path.basename(kimiSessionPath) },
      { name: 'credential-field:access_token', value: 'access_token' },
      { name: 'credential-field:refresh_token', value: 'refresh_token' },
      { name: 'credential-field:account_id', value: 'account_id' },
      { name: 'authorization-header', value: 'Authorization' },
      { name: 'bearer-header', value: 'Bearer ' },
      { name: 'stack-frame-text', value: 'fixture-stack-frame' }
    ];
    assertSensitivePayloadAbsent(progressEvents, forbiddenOutput, 'progress events');
    assertSensitivePayloadAbsent(copiedReports[0], forbiddenOutput, 'copied report');

    const fullRemoteCalls = remote.calls.slice();
    assert.equal(remote.overlapEntries(), 3);
    assert.equal(remote.peak() >= 3, true, 'remote overlap oracle must observe at least three active calls');
    assert.equal(remote.peak() <= 3, true, 'assembled runner must cap remote concurrency at three');
    assert.equal(remote.active(), 0);
    assert.deepEqual(remote.errors, []);
    const networkCalls = fullRemoteCalls.filter((call) => call.type === 'network.probe');
    assert.deepEqual(new Set(networkCalls.map((call) => call.url)), new Set([
      'https://api.deepseek.com/user/balance',
      'https://platform.deepseek.com/usage',
      'https://chatgpt.com/backend-api/wham/usage',
      'https://api.kimi.com/coding/v1/usages'
    ]));
    for (const call of networkCalls) {
      assert.deepEqual(call.headers, {});
      assert.equal(call.proxyInput, null);
      assert.deepEqual({
        connectTimeoutMs: call.timeoutOptions.connectTimeoutMs,
        connectResponseTimeoutMs: call.timeoutOptions.connectResponseTimeoutMs,
        tlsHandshakeTimeoutMs: call.timeoutOptions.tlsHandshakeTimeoutMs,
        requestTimeoutMs: call.timeoutOptions.requestTimeoutMs
      }, {
        connectTimeoutMs: 5000,
        connectResponseTimeoutMs: 5000,
        tlsHandshakeTimeoutMs: 5000,
        requestTimeoutMs: 8000
      });
      assert.equal(call.timeoutOptions.signal instanceof AbortSignal, true);
      assert.equal(Number.isFinite(call.timeoutOptions.deadlineMs), true);
    }
    const deepseekKeyCall = fullRemoteCalls.find((call) => call.type === 'provider.deepseek-api-key');
    assert.equal(deepseekKeyCall.url, 'https://api.deepseek.com/user/balance');
    assert.equal(deepseekKeyCall.key, sentinels.deepseekApiKey);
    assert.equal(typeof deepseekKeyCall.options.httpGet, 'function');
    assert.notEqual(deepseekKeyCall.options.httpGet, remote.httpGet);
    assert.equal(deepseekKeyCall.options.proxyUrl, null);
    const deepseekSessionCall = fullRemoteCalls.find((call) => call.type === 'provider.deepseek-session');
    assert.equal(deepseekSessionCall.url, 'https://platform.deepseek.com/usage');
    assert.equal(deepseekSessionCall.token, sentinels.deepseekSession);
    assert.equal(deepseekSessionCall.month, 5);
    assert.equal(deepseekSessionCall.year, 2033);
    assert.equal(typeof deepseekSessionCall.options.httpGet, 'function');
    assert.notEqual(deepseekSessionCall.options.httpGet, remote.httpGet);
    assert.equal(deepseekSessionCall.options.proxyUrl, null);
    const codexQuotaCall = fullRemoteCalls.find((call) => call.type === 'provider.codex-quota');
    assert.equal(codexQuotaCall.url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.deepEqual(codexQuotaCall.headers, {
      Authorization: `Bearer ${sentinels.codexAccess}`,
      'ChatGPT-Account-Id': sentinels.codexAccount,
      'User-Agent': 'codex_cli_rs/0.46.0'
    });
    const kimiQuotaCall = fullRemoteCalls.find((call) => call.type === 'provider.kimi-quota');
    assert.equal(kimiQuotaCall.url, 'https://api.kimi.com/coding/v1/usages');
    assert.deepEqual(kimiQuotaCall.headers, {
      Authorization: `Bearer ${sentinels.kimiAccess}`,
      'User-Agent': 'kimi_cli'
    });
    assert.equal(fullRemoteCalls.length, 8);
    assert.equal(JSON.stringify(fullRemoteCalls).includes('Authorization'), true);

    storeValues['providers.proxyUrl'] = 'http://127.0.0.1:7890';
    const runBRemoteCallStart = remote.calls.length;
    blockedRemote = remote.blockNext();
    const staleRun = diagnostics.start(rendererWindow.webContents);
    assert.equal(staleRun.runId, runIds[1]);
    await withTimeout(blockedRemote.started, 5000, 'blocked remote start');
    const runBProxyMode = remote.calls.slice(runBRemoteCallStart)
      .some((call) => call.proxyInput === 'http://127.0.0.1:7890')
      ? 'custom'
      : 'unknown';
    assert.equal(runBProxyMode, 'custom');
    const staleEventsAtReplacement = progressEvents.filter((event) => event.runId === staleRun.runId).length;
    const replacementRun = diagnostics.start(rendererWindow.webContents);
    assert.equal(replacementRun.runId, runIds[2]);
    await withTimeout(remote.waitForIdle(), 2000, 'replacement abort remote idle');
    const activeRemoteAfterAbort = remote.active();
    assert.equal(activeRemoteAfterAbort, 0);
    const remotePeakAcrossReruns = remote.peak();
    assert.equal(remotePeakAcrossReruns <= 3, true);
    await withTimeout(
      rendererWindow.waitFor((event) => (
        event.runId === replacementRun.runId
        && event.check.id === 'storage.temp-write'
        && ['pass', 'fail', 'skipped'].includes(event.check.status)
      )),
      5000,
      'replacement storage progress'
    );
    assert.equal(
      progressEvents.filter((event) => event.runId === staleRun.runId).length,
      staleEventsAtReplacement,
      'the replaced run must stop emitting immediately'
    );

    rendererWindow.close();
    diagnostics.dispose(rendererWindow.webContents.id);
    const eventsAtClose = progressEvents.length;
    blockedRemote.release();
    await withTimeout(remote.waitForIdle(), 2000, 'post-close remote idle');
    await withTimeout(new Promise((resolve) => setImmediate(resolve)), 1000, 'post-close event drain');
    assert.equal(progressEvents.length, eventsAtClose);
    assert.equal(progressEvents.filter((event) => event.runId === staleRun.runId).length, staleEventsAtReplacement);
    assert.equal(rendererWindow.sendsAfterClose(), 0);
    assertSensitivePayloadAbsent(progressEvents, forbiddenOutput, 'all progress events');
    assert.equal(remote.active(), 0);
    assert.deepEqual(remote.errors, []);

    assert.deepEqual(storeAudit.violations, []);
    assert.deepEqual(fsAudit.violations, []);
    assert.equal(fs.readFileSync(codexAuthPath).equals(codexBefore), true);
    assert.equal(fs.readFileSync(kimiCredPath).equals(kimiBefore), true);
    assert.equal(fs.readFileSync(collisionPath).equals(collisionBytesBefore), true);
    assert.deepEqual(findDiagnosticTempFiles(userDataDir), [path.basename(collisionPath)]);
    assert.deepEqual(
      new Set(fsAudit.reads.filter((entry) => entry.method === 'readFileSync')
        .map((entry) => entry.target)
        .filter((target) => target === codexAuthPath || target === kimiCredPath)),
      new Set([codexAuthPath, kimiCredPath])
    );
    assert.deepEqual(
      new Set(fsAudit.reads.filter((entry) => entry.method === 'openSync:r').map((entry) => entry.target)),
      new Set([codexSessionPath, kimiSessionPath])
    );
    assert.ok(fsAudit.tempLifecycles.size >= 2);
    assert.equal(Array.from(fsAudit.tempLifecycles.values()).every((lifecycle) => (
      lifecycle.removed && lifecycle.events.join(',') === 'open,write,fsync,close,remove'
    )), true);
    assert.deepEqual(windowsAudit.systemMutations, []);
    assert.deepEqual(windowsAudit.violations, []);
    assert.deepEqual(windowsAudit.lifecycle, {
      created: true,
      nativeHandleRead: true,
      accentApplied: true,
      materialApplied: true,
      accentCleared: true,
      destroyed: true
    });
    assert.equal(windowsAudit.calls.filter((entry) => Array.isArray(entry) && entry[0] === 'create').length, 3);
    assert.equal(windowsAudit.calls.filter((entry) => Array.isArray(entry) && entry[0] === 'destroy').length, 3);
  } finally {
    try {
      if (blockedRemote) blockedRemote.release();
      if (remote) remote.releaseAll();
      if (diagnostics && rendererWindow) diagnostics.dispose(rendererWindow.webContents.id);
      if (rendererWindow) rendererWindow.dispose();
      if (remote) await withTimeout(remote.waitForIdle(), 2000, 'remote cleanup');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
