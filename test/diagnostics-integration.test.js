const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDiagnostics } = require('../src/main/core/diagnostics');
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function findDiagnosticTempFiles(userDataDir) {
  return fs.readdirSync(userDataDir).filter((name) => /^\.diagnostics-.*\.tmp$/.test(name));
}

function createRemoteBoundary() {
  let nextBlock = null;
  return {
    blockNext() {
      const started = deferred();
      const released = deferred();
      nextBlock = { started, released, claimed: false };
      return {
        started: started.promise,
        release: () => released.resolve()
      };
    },
    async httpGet() {
      if (nextBlock && !nextBlock.claimed) {
        nextBlock.claimed = true;
        nextBlock.started.resolve();
        await nextBlock.released.promise;
      }
      return { ok: true };
    }
  };
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
    close() { closed = true; },
    sendsAfterClose: () => sendsAfterClose,
    waitFor(predicate) {
      const existing = progressEvents.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error('timed out waiting for diagnostics progress'));
        }, 5000);
        waiters.add(waiter);
      });
    }
  };
}

function createWindowsBoundary(calls, privateGpuValue) {
  const nativeHandle = Buffer.alloc(8, 1);
  const library = {
    func(signature) {
      if (signature.includes('DwmIsCompositionEnabled')) {
        return (enabled) => {
          enabled.writeInt32LE(1);
          return 0;
        };
      }
      return () => true;
    }
  };
  return {
    platform: 'win32',
    release: '10.0.19045',
    koffi: { load: () => library },
    BrowserWindow: function BrowserWindow(options) {
      calls.push(['create', options]);
      return {
        getNativeWindowHandle: () => nativeHandle,
        setBackgroundMaterial: (material) => calls.push(['material', material]),
        destroy: () => calls.push(['destroy'])
      };
    },
    createAccentApi: () => ({ enable() {}, disable() {} }),
    applyAccent: () => true,
    clearAccent: () => calls.push(['clear']),
    app: {
      getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }),
      getGPUInfo: async () => ({
        auxAttributes: { amdSwitchable: 0, optimus: 1 },
        gpuDevice: [{ driver_version: privateGpuValue }]
      })
    }
  };
}

function terminalResultsForRun(events, runId) {
  const terminal = new Set(['pass', 'fail', 'skipped']);
  const byId = new Map();
  for (const event of events) {
    if (event.runId === runId && terminal.has(event.check.status)) byId.set(event.check.id, event.check);
  }
  return EXPECTED_CHECK_IDS.map((id) => byId.get(id)).filter(Boolean);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('assembled diagnostics preserves private state, cleans temporary files, and stops stale closed-window sends', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-integration-'));
  try {
    const nowMs = 2_000_000_000_000;
    const userDataDir = path.join(root, 'user-data');
    const buildDir = path.join(root, 'build-inputs');
    const codexSessionsRoot = path.join(root, 'codex-sessions');
    const kimiSessionsRoot = path.join(root, 'kimi-sessions');
    const codexAuthPath = path.join(root, 'codex-auth-fixture.json');
    const kimiCredPath = path.join(root, 'kimi-credential-fixture.json');
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
      scheduler: 'scheduler-error-secret-fixture-28d4'
    };

    fs.mkdirSync(userDataDir);
    fs.mkdirSync(buildDir);
    fs.mkdirSync(path.join(codexSessionsRoot, 'run'), { recursive: true });
    fs.mkdirSync(path.join(kimiSessionsRoot, 'run'), { recursive: true });
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
    fs.writeFileSync(path.join(codexSessionsRoot, 'run', 'rollout-fixture.jsonl'), JSON.stringify({
      type: 'event_msg',
      private: sentinels.codexLog,
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 2, total_tokens: 3 } } }
    }) + '\n');
    fs.writeFileSync(path.join(kimiSessionsRoot, 'run', 'wire-fixture.jsonl'), JSON.stringify({
      type: 'usage.record',
      private: sentinels.kimiLog,
      usage: { inputOther: 1, inputCacheRead: 2, output: 3 }
    }) + '\n');

    const codexBefore = fs.readFileSync(codexAuthPath);
    const kimiBefore = fs.readFileSync(kimiCredPath);
    const storeMutations = [];
    const storeValues = {
      'data.historyDays': 7,
      'providers.proxyUrl': '',
      'providers.deepseek.apiKey': sentinels.deepseekApiKey,
      'providers.deepseek.sessionToken': sentinels.deepseekSession
    };
    const store = {
      get: (key) => storeValues[key],
      set: (...args) => storeMutations.push(['set', ...args]),
      delete: (...args) => storeMutations.push(['delete', ...args]),
      clear: (...args) => storeMutations.push(['clear', ...args])
    };
    const exclusiveUserDataWrites = [];
    const storageFs = Object.create(fs);
    storageFs.openSync = (target, flags, mode) => {
      if (path.dirname(target) === userDataDir && flags === 'wx') exclusiveUserDataWrites.push(target);
      return fs.openSync(target, flags, mode);
    };
    const remote = createRemoteBoundary();
    const windowsCalls = [];
    const progressEvents = [];
    const rendererWindow = createRendererWindow(progressEvents);
    const copiedReports = [];
    const runIds = ['assembled-full-run', 'assembled-stale-run', 'assembled-replacement-run'];
    let nextRunId = 0;

    const diagnostics = createDiagnostics({
      runtime: {
        versions: { app: '1.0.0', electron: '40.0.0', node: '22.0.0', chromium: '140.0.0' },
        platform: 'win32',
        arch: 'x64',
        release: '10.0.19045',
        buildPaths: Object.assign({ fs }, buildPaths),
        getWindows: () => ({ main: rendererWindow, settings: null, login: null, session: null })
      },
      storage: {
        fs: storageFs,
        crypto,
        path,
        userDataDir,
        store,
        validateEncryptionKey,
        normalizeStoredProxyValue
      },
      windows: createWindowsBoundary(windowsCalls, sentinels.gpu),
      network: { store, httpGet: remote.httpGet },
      providers: {
        fs,
        store,
        now: () => nowMs,
        tokenExpiryMs: () => nowMs + 3600_000,
        codexAuthPath,
        codexSessionsRoot,
        kimiCredPath,
        kimiSessionsRoot,
        fetchBalance: async () => ({ available: true }),
        UsageFetcher: class UsageFetcher {
          async fetchUsageAmount() { return { aggregate: { totalTokens: 1 } }; }
        },
        httpGet: remote.httpGet
      },
      scheduler: {
        getSnapshot: () => ['deepseek', 'codex', 'kimi'].map((id) => ({
          id,
          authStatus: 'ok',
          lastError: id === 'deepseek' ? `HTTP 503 ${sentinels.scheduler}` : null,
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
    await fullCompletion;

    const results = terminalResultsForRun(progressEvents, fullRun.runId);
    assert.equal(results.length, EXPECTED_CHECK_IDS.length);
    assert.equal(results.every((item) => ['pass', 'fail', 'skipped'].includes(item.status)), true);
    assert.equal(results.some((item) => item.status === 'fail'), true);
    assert.equal(results.filter((item) => item.status === 'fail').every((item) => item.guideId), true);
    assert.equal(results.find((item) => item.id === 'runtime.self-check').status, 'pass');
    assert.deepEqual(storeMutations, []);
    assert.equal(fs.readFileSync(codexAuthPath).equals(codexBefore), true);
    assert.equal(fs.readFileSync(kimiCredPath).equals(kimiBefore), true);
    assert.equal(findDiagnosticTempFiles(userDataDir).length, 0);

    const copied = await diagnostics.copy(rendererWindow.webContents, fullRun.runId);
    assert.equal(copied.ok, true);
    assert.equal(copiedReports.length, 1);
    const secretPattern = new RegExp(Object.values(sentinels).map(escapeRegExp).join('|'));
    assert.doesNotMatch(JSON.stringify(progressEvents), secretPattern);
    assert.doesNotMatch(copiedReports[0], secretPattern);

    const blockedRemote = remote.blockNext();
    const staleRun = diagnostics.start(rendererWindow.webContents);
    assert.equal(staleRun.runId, runIds[1]);
    await blockedRemote.started;
    const staleEventsAtReplacement = progressEvents.filter((event) => event.runId === staleRun.runId).length;
    const replacementRun = diagnostics.start(rendererWindow.webContents);
    assert.equal(replacementRun.runId, runIds[2]);
    await rendererWindow.waitFor((event) => event.runId === replacementRun.runId && event.check.status === 'running');
    assert.equal(
      progressEvents.filter((event) => event.runId === staleRun.runId).length,
      staleEventsAtReplacement,
      'the replaced run must stop emitting immediately'
    );

    rendererWindow.close();
    const eventsAtClose = progressEvents.length;
    blockedRemote.release();
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(progressEvents.length, eventsAtClose);
    assert.equal(progressEvents.filter((event) => event.runId === staleRun.runId).length, staleEventsAtReplacement);
    assert.equal(rendererWindow.sendsAfterClose(), 0);
    assert.doesNotMatch(JSON.stringify(progressEvents), secretPattern);
    diagnostics.dispose(rendererWindow.webContents.id);

    assert.deepEqual(storeMutations, []);
    assert.equal(fs.readFileSync(codexAuthPath).equals(codexBefore), true);
    assert.equal(fs.readFileSync(kimiCredPath).equals(kimiBefore), true);
    assert.equal(findDiagnosticTempFiles(userDataDir).length, 0);
    assert.ok(exclusiveUserDataWrites.length >= 2);
    assert.equal(exclusiveUserDataWrites.every((target) => (
      path.dirname(target) === userDataDir && /^\.diagnostics-.*\.tmp$/.test(path.basename(target))
    )), true);
    assert.equal(windowsCalls.filter((call) => call[0] === 'destroy').length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
