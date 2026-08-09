const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runDiagnostics } = require('../src/main/core/diagnostics/runner');
const { validateEncryptionKey } = require('../src/main/core/encryption-key');
const { normalizeStoredProxyValue } = require('../src/main/core/proxy-settings');
const { createRuntimeChecks } = require('../src/main/core/diagnostics/checks/runtime');
const { createStorageChecks } = require('../src/main/core/diagnostics/checks/storage');

function byId(results, id) {
  return results.find((result) => result.id === id);
}

function makeStore(values, writes, reads = []) {
  return {
    get(key) {
      reads.push(key);
      return values[key];
    },
    set() {
      writes.push('set');
      throw new Error('diagnostics must not write the Store');
    },
    delete() {
      writes.push('delete');
      throw new Error('diagnostics must not write the Store');
    },
    clear() {
      writes.push('clear');
      throw new Error('diagnostics must not write the Store');
    }
  };
}

function makeRuntimeDependencies(root, overrides = {}) {
  const artifacts = {
    mainRenderer: path.join(root, 'renderer.html'),
    preload: path.join(root, 'preload.js'),
    diagnosticsPage: path.join(root, 'diagnostics.html')
  };
  for (const artifact of Object.values(artifacts)) fs.writeFileSync(artifact, 'artifact');

  return Object.assign({
    versions: { app: '1.2.3', electron: '40.0.0', node: '22.0.0', chromium: '140.0.0' },
    platform: 'linux',
    arch: 'x64',
    release: '6.1.0',
    buildPaths: Object.assign({ fs }, artifacts),
    getWindows: () => ({ main: {}, settings: null, login: undefined, session: {} })
  }, overrides);
}

function makeStorageDependencies(userDataDir, store, overrides = {}) {
  return Object.assign({
    fs,
    crypto,
    path,
    userDataDir,
    store,
    validateEncryptionKey,
    normalizeStoredProxyValue
  }, overrides);
}

async function runChecks(checks) {
  return runDiagnostics({
    runId: 'runtime-storage-test',
    checks,
    emit() {},
    isActive: () => true
  });
}

test('runtime and storage checks report safe initialized state without Store writes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-runtime-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'user-data');
  fs.mkdirSync(userDataDir);
  fs.writeFileSync(path.join(userDataDir, '.key'), 'ab'.repeat(32));
  fs.writeFileSync(path.join(userDataDir, 'config.json'), Buffer.from([0x00, 0xff, 0x10, 0x80]));

  const writeCalls = [];
  const readCalls = [];
  const store = makeStore({
    'providers.proxyUrl': 'http://127.0.0.1:7890',
    'data.historyDays': 7
  }, writeCalls, readCalls);
  const checks = [
    ...createRuntimeChecks(makeRuntimeDependencies(root)),
    ...createStorageChecks(makeStorageDependencies(userDataDir, store))
  ];
  const results = await runChecks(checks);

  assert.equal(byId(results, 'runtime.versions').status, 'pass');
  assert.equal(byId(results, 'runtime.renderer-build').status, 'pass');
  assert.equal(byId(results, 'storage.store-initialized').status, 'pass');
  assert.equal(byId(results, 'storage.config-readable').status, 'pass');
  assert.equal(byId(results, 'storage.encryption-state').metadata.keyValid, true);
  assert.equal(byId(results, 'storage.settings-schema').status, 'pass');
  assert.equal(fs.readdirSync(userDataDir).some((name) => name.startsWith('.diagnostics-')), false);
  assert.deepEqual(writeCalls, []);
  assert.deepEqual(readCalls, ['data.historyDays', 'providers.proxyUrl', 'data.historyDays']);
  assert.equal(JSON.stringify(results).includes('ab'.repeat(32)), false);
  assert.equal(JSON.stringify(results).includes('127.0.0.1:7890'), false);
  for (const result of results) assert.ok(result.guideId);
});

test('runtime and storage checks report missing artifacts and invalid persisted settings', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-runtime-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'user-data');
  fs.mkdirSync(userDataDir);
  fs.writeFileSync(path.join(userDataDir, '.key'), 'not-a-key');
  fs.writeFileSync(path.join(userDataDir, 'config.json'), Buffer.from([0x99, 0x01]));
  const writes = [];
  const store = makeStore({
    'providers.proxyUrl': 'https://invalid.example',
    'data.historyDays': 0
  }, writes);
  const runtime = makeRuntimeDependencies(root);
  fs.rmSync(runtime.buildPaths.mainRenderer);
  const results = await runChecks([
    ...createRuntimeChecks(runtime),
    ...createStorageChecks(makeStorageDependencies(userDataDir, store))
  ]);

  assert.equal(byId(results, 'runtime.renderer-build').status, 'fail');
  assert.equal(byId(results, 'storage.encryption-state').status, 'fail');
  assert.equal(byId(results, 'storage.encryption-state').metadata.keyValid, false);
  assert.equal(byId(results, 'storage.settings-schema').status, 'fail');
  assert.deepEqual(writes, []);
  for (const result of results) {
    assert.ok(result.guideId);
    assert.equal(JSON.stringify(result.metadata).includes('not-a-key'), false);
  }
});

test('temp-write removes its exclusive file after an injected close failure or post-remove failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-runtime-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataDir = path.join(root, 'user-data');
  fs.mkdirSync(userDataDir);
  fs.writeFileSync(path.join(userDataDir, '.key'), 'ab'.repeat(32));
  fs.writeFileSync(path.join(userDataDir, 'config.json'), Buffer.from([0x00]));
  const store = makeStore({ 'providers.proxyUrl': '', 'data.historyDays': 1 }, []);
  const cleanupCalls = [];
  const closeFailingFs = Object.assign({}, fs, {
    closeSync(fd) {
      cleanupCalls.push('close');
      fs.closeSync(fd);
      throw Object.assign(new Error('close failure'), { code: 'CLOSE_FAILED' });
    },
    rmSync(target, options) {
      cleanupCalls.push('remove');
      return fs.rmSync(target, options);
    }
  });
  const closeResults = await runChecks(createStorageChecks(makeStorageDependencies(userDataDir, store, { fs: closeFailingFs })));
  assert.equal(byId(closeResults, 'storage.temp-write').status, 'fail');
  assert.deepEqual(cleanupCalls, ['close', 'remove']);
  assert.equal(fs.readdirSync(userDataDir).some((name) => name.startsWith('.diagnostics-')), false);

  const removeFailingFs = Object.assign({}, fs, {
    rmSync(target, options) {
      if (path.basename(target).startsWith('.diagnostics-')) {
        fs.rmSync(target, options);
        throw Object.assign(new Error('remove failure'), { code: 'REMOVE_FAILED' });
      }
      return fs.rmSync(target, options);
    }
  });
  const removeResults = await runChecks(createStorageChecks(makeStorageDependencies(userDataDir, store, { fs: removeFailingFs })));
  assert.equal(byId(removeResults, 'storage.temp-write').status, 'fail');
  assert.equal(fs.readdirSync(userDataDir).some((name) => name.startsWith('.diagnostics-')), false);
});

test('storage factory defers invalid user-data paths and reports stable terminal failures', async () => {
  const checks = createStorageChecks(makeStorageDependencies(undefined, makeStore({
    'providers.proxyUrl': '',
    'data.historyDays': 1
  }, [])));
  const results = await runChecks(checks);

  assert.equal(byId(results, 'storage.user-data-access').status, 'fail');
  assert.equal(byId(results, 'storage.config-readable').status, 'fail');
  assert.equal(byId(results, 'storage.temp-write').status, 'fail');
  assert.equal(byId(results, 'storage.encryption-state').status, 'fail');
  for (const result of results) assert.ok(result.guideId);
});

test('runtime self-check requires every injected preceding result exactly once and terminal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-runtime-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expectedCheckIds = [
    'runtime.versions', 'runtime.windows-build', 'runtime.renderer-build',
    'runtime.ipc-roundtrip', 'runtime.window-references',
    'storage.user-data-access', 'storage.store-initialized', 'storage.config-readable',
    'storage.temp-write', 'storage.encryption-state', 'storage.settings-schema'
  ];
  const checks = createRuntimeChecks(makeRuntimeDependencies(root, { expectedCheckIds }));
  const results = await runChecks(checks);
  assert.equal(byId(results, 'runtime.self-check').status, 'fail');

  const selfCheck = checks.find((check) => check.id === 'runtime.self-check');
  const terminal = expectedCheckIds.map((id) => ({ id, status: 'pass' }));
  assert.equal(selfCheck.run({ getResults: () => terminal }).status, 'pass');
  assert.equal(selfCheck.run({ getResults: () => terminal.concat(terminal[0]) }).status, 'fail');
  assert.equal(selfCheck.run({ getResults: () => terminal.map((result, index) => index === 0 ? { id: result.id, status: 'running' } : result) }).status, 'fail');
});

test('runtime and storage definitions keep their fixed diagnostics contract', () => {
  const runtimeChecks = createRuntimeChecks({
    versions: { app: '1.2.3', electron: '40.0.0', node: '22.0.0', chromium: '140.0.0' },
    platform: 'linux',
    arch: 'x64',
    release: '6.1.0',
    buildPaths: {},
    getWindows: () => ({})
  });
  const storageChecks = createStorageChecks(makeStorageDependencies(os.tmpdir(), makeStore({}, [])));
  assert.deepEqual(runtimeChecks.map((check) => [check.id, check.phase, check.timeoutMs, check.guideId]), [
    ['runtime.versions', 'local', 3000, 'app-runtime'],
    ['runtime.windows-build', 'windows', 3000, 'app-runtime'],
    ['runtime.renderer-build', 'local', 3000, 'app-runtime'],
    ['runtime.ipc-roundtrip', 'local', 3000, 'app-runtime'],
    ['runtime.window-references', 'local', 3000, 'app-runtime'],
    ['runtime.self-check', 'final', 3000, 'app-runtime']
  ]);
  assert.deepEqual(storageChecks.map((check) => [check.id, check.phase, check.timeoutMs, check.guideId]), [
    ['storage.user-data-access', 'local', 3000, 'storage-user-data'],
    ['storage.store-initialized', 'local', 3000, 'storage-config'],
    ['storage.config-readable', 'local', 3000, 'storage-config'],
    ['storage.temp-write', 'local', 3000, 'storage-user-data'],
    ['storage.encryption-state', 'local', 3000, 'storage-config'],
    ['storage.settings-schema', 'local', 3000, 'storage-config']
  ]);
  assert.deepEqual(runtimeChecks[0].run().metadata, {
    app: '1.2.3',
    electron: '40.0.0',
    node: '22.0.0',
    chromium: '140.0.0',
    platform: 'linux',
    arch: 'x64',
    release: '6.1.0'
  });
});
