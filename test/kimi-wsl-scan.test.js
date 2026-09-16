const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWslPathGuard, wslDistroFromPath, detectWslKimiRoots } = require('../src/main/providers/kimi/wsl-roots');
const { readLocalLog } = require('../src/main/providers/kimi/locallog');
const { scanFileBatch } = require('../src/main/core/locallog');
const { rescanLocalLogs } = require('../src/main/core/history-sync');

const remote = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\.kimi-code\\sessions';
const remoteFile = remote + '\\wire.jsonl';
function execResult(names, error) {
  return (cmd, args, options, callback) => {
    assert.equal(cmd, 'wsl.exe');
    assert.deepEqual(args, ['-l', '--running', '-q']);
    assert.equal(options.windowsHide, true);
    callback(error, names.join('\r\n'));
  };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-wsl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  fs.writeFileSync(path.join(root, 'wire.jsonl'), JSON.stringify({
    type: 'usage.record', time: now, usage: { inputOther: 3, output: 2 }
  }) + '\n');
  const data = {
    'providers.kimi.localLogRoot': root,
    'providers.kimi.autoLogRoots': [remote],
    'localLogMigrations.kimiTotalIncludesCached': true,
    'localLogCursors.kimi': { [remoteFile]: { offset: 1234, mtimeMs: now } },
    usageDaily: { 'kimi:2026-01-01': { input: 8, cached: 0, output: 2, total: 10 } }
  };
  return { root, data, get: (k) => data[k], set: (k, v) => { data[k] = v; } };
}
function forbidRemoteIo(t) {
  const touched = [];
  for (const method of ['access', 'readdir', 'stat', 'open']) {
    const original = fs.promises[method].bind(fs.promises);
    t.mock.method(fs.promises, method, async (target, ...args) => {
      if (wslDistroFromPath(target)) {
        touched.push([method, target]);
        throw new Error('Unexpected WSL filesystem access');
      }
      return original(target, ...args);
    });
  }
  return touched;
}

test('WSL path guard recognizes UNC aliases and does not cache running state', async () => {
  for (const target of [remote, '//WSL.LOCALHOST/Ubuntu-24.04/home', '\\\\wsl$\\Ubuntu-24.04\\home', '\\\\?\\UNC\\wsl.localhost\\Ubuntu-24.04\\home']) {
    assert.equal(wslDistroFromPath(target), 'Ubuntu-24.04');
  }
  let running = ['ubuntu-24.04'];
  let calls = 0;
  const guard = createWslPathGuard({ execFileImpl: (...args) => {
    calls++;
    execResult(running)(...args);
  } });
  assert.equal(await guard('C:\\logs'), true);
  assert.equal(await guard('\\\\server\\share'), true);
  assert.equal(calls, 0);
  assert.equal(await guard(remote), true);
  running = [];
  assert.equal(await guard(remote), false);
  assert.equal(calls, 2);
});

for (const failed of [false, true]) {
  test(`stopped/query-failed WSL is never touched, local logs and remote cursors survive (${failed})`, async (t) => {
    const store = fixture(t);
    const touched = forbidRemoteIo(t);
    const cursor = structuredClone(store.get('localLogCursors.kimi')[remoteFile]);
    const opts = { execFileImpl: execResult(['docker-desktop'], failed ? new Error('timeout') : null) };
    assert.equal((await readLocalLog({ store }, opts)).records.length, 1);
    assert.equal((await readLocalLog({ store }, opts)).records.length, 0);
    assert.deepEqual(store.get('localLogCursors.kimi')[remoteFile], cursor);
    assert.equal(store.get('usageDaily')['kimi:2026-01-01'].total, 10);
    assert.deepEqual(touched, []);
  });
}

test('manual full rescan rolls back old usage and cursors when WSL is stopped', async (t) => {
  const store = fixture(t);
  const before = structuredClone(store.data);
  const touched = forbidRemoteIo(t);
  await assert.rejects(rescanLocalLogs({
    providerId: 'kimi', readStore: store.get, writeStore: store.set,
    readLocalLog: () => readLocalLog({ store }, { retainAll: true, execFileImpl: execResult([]) })
  }), { code: 'WSL_LOG_ROOT_UNAVAILABLE' });
  assert.deepEqual(store.get('usageDaily'), before.usageDaily);
  assert.deepEqual(store.get('localLogCursors.kimi'), before['localLogCursors.kimi']);
  assert.deepEqual(touched, []);
});

test('custom and manually added WSL roots also skip filesystem access', async (t) => {
  const store = fixture(t);
  const touched = forbidRemoteIo(t);
  store.set('providers.kimi.autoLogRoots', []);
  store.set('providers.kimi.extraLogRoots', [remote]);
  assert.equal((await readLocalLog({ store }, { execFileImpl: execResult([]) })).records.length, 1);
  store.set('providers.kimi.extraLogRoots', []);
  store.set('providers.kimi.localLogRoot', remote);
  assert.equal((await readLocalLog({ store }, { execFileImpl: execResult([]) })).records.length, 0);
  assert.deepEqual(touched, []);
});

test('running WSL scans normally, stops without IO, and resumes incrementally', async (t) => {
  const store = fixture(t);
  store.set('providers.kimi.localLogRoot', remote);
  store.set('providers.kimi.autoLogRoots', []);
  store.set('localLogCursors.kimi', {});
  let running = ['Ubuntu-24.04'];
  let remoteIo = 0;
  for (const method of ['access', 'readdir', 'stat', 'open']) {
    const original = fs.promises[method].bind(fs.promises);
    t.mock.method(fs.promises, method, async (target, ...args) => {
      if (String(target).startsWith(remote)) {
        remoteIo++;
        target = path.join(store.root, String(target).slice(remote.length).replace(/^[\\/]/, ''));
      }
      return original(target, ...args);
    });
  }
  const options = { execFileImpl: (...args) => execResult(running)(...args) };
  assert.equal((await readLocalLog({ store }, options)).records.length, 1);
  const cursor = structuredClone(store.get('localLogCursors.kimi'));
  const before = remoteIo;
  running = [];
  assert.equal((await readLocalLog({ store }, options)).records.length, 0);
  assert.equal(remoteIo, before);
  assert.deepEqual(store.get('localLogCursors.kimi'), cursor);
  running = ['Ubuntu-24.04'];
  fs.appendFileSync(path.join(store.root, 'wire.jsonl'), JSON.stringify({
    type: 'usage.record', time: Date.now(), usage: { inputOther: 7, output: 1 }
  }) + '\n');
  const resumed = await readLocalLog({ store }, options);
  assert.equal(resumed.records.length, 1);
  assert.equal(resumed.records[0].usage.total, 8);
  assert.equal((await readLocalLog({ store }, options)).records.length, 0);
});

test('discovery rechecks state before UNC access after initial enumeration', async () => {
  let calls = 0;
  let touched = 0;
  const roots = await detectWslKimiRoots({
    execFileImpl: (...args) => execResult(calls++ === 0 ? ['Ubuntu-24.04'] : [])(...args),
    fsImpl: { promises: {
      readdir: async () => { touched++; return []; },
      access: async () => { touched++; }
    } }
  });
  assert.deepEqual(roots, []);
  assert.equal(touched, 0);
});

test('scanner rechecks before opening a file and resumes without losing its cursor', async (t) => {
  const store = fixture(t);
  const file = path.join(store.root, 'wire.jsonl');
  store.set('cursors', { [file]: { offset: 0, mtimeMs: 0 }, [remoteFile]: { offset: 1234 } });
  let checks = 0;
  let opens = 0;
  const originalOpen = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'open', async (...args) => { opens++; return originalOpen(...args); });
  const options = {
    root: store.root, match: /wire\.jsonl$/, cursorStore: store, cursorKey: 'cursors',
    providerId: 'kimi', parseLine: JSON.parse,
    canAccessPath: async (target) => target !== file || ++checks === 1
  };
  const skipped = await scanFileBatch(options);
  assert.equal(skipped.complete, false);
  assert.equal(opens, 0);
  assert.equal(store.get('cursors')[file].offset, 0);
  const resumed = await scanFileBatch({ ...options, canAccessPath: async () => true });
  assert.equal(resumed.records.length, 1);
  assert.equal((await scanFileBatch({ ...options, canAccessPath: async () => true })).records.length, 0);
  assert.equal(store.get('cursors')[remoteFile].offset, 1234);
});
