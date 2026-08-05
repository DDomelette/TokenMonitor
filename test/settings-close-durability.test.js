const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createFakeTimers() {
  let nextId = 1;
  const tasks = new Map();
  return {
    tasks,
    setTimeout(callback, delay) {
      const id = nextId++;
      tasks.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    runAll() {
      const pending = Array.from(tasks.values());
      tasks.clear();
      pending.forEach((task) => task.callback());
    }
  };
}

function loadDebounce() {
  delete require.cache[require.resolve('../src/renderer/js/settings-debounce')];
  return require('../src/renderer/js/settings-debounce');
}

function loadSettingsWrite() {
  return require('../src/main/core/settings-write');
}

test('flush emits every pending key immediately and waits for every acknowledgement', async () => {
  const { createKeyedDebouncer } = loadDebounce();
  const timers = createFakeTimers();
  const acknowledgements = {
    'window.opacity': deferred(),
    'components.balance': deferred()
  };
  const emitted = [];
  const queue = createKeyedDebouncer({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onEmit(key, value) {
      emitted.push([key, value]);
      return acknowledgements[key].promise;
    }
  });

  queue.schedule('window.opacity', 78);
  queue.schedule('components.balance', false);

  const flushing = queue.flush();
  await Promise.resolve();
  assert.equal(timers.tasks.size, 0);
  assert.deepEqual(emitted, [
    ['window.opacity', 78],
    ['components.balance', false]
  ]);

  let settled = false;
  flushing.then(() => { settled = true; }, () => { settled = true; });
  acknowledgements['window.opacity'].resolve({ ok: true });
  await flushEvents();
  assert.equal(settled, false, 'close must still wait for the second acknowledgement');

  acknowledgements['components.balance'].resolve({ ok: true });
  await flushing;
  assert.equal(settled, true);
  assert.equal(queue.hasPending(), false);
});

test('flush waits for a timer-triggered write that is already in flight', async () => {
  const { createKeyedDebouncer } = loadDebounce();
  const timers = createFakeTimers();
  const acknowledgement = deferred();
  const emitted = [];
  const queue = createKeyedDebouncer({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onEmit(key, value) {
      emitted.push([key, value]);
      return acknowledgement.promise;
    }
  });

  queue.schedule('data.historyDays', '30');
  timers.runAll();
  await Promise.resolve();
  assert.deepEqual(emitted, [['data.historyDays', '30']]);

  let settled = false;
  const flushing = queue.flush().then(() => { settled = true; });
  await flushEvents();
  assert.equal(settled, false);
  acknowledgement.resolve({ ok: true });
  await flushing;
  assert.equal(settled, true);
});

test('failed writes are restored as pending and a later close retry can persist them', async () => {
  const { createKeyedDebouncer } = loadDebounce();
  const timers = createFakeTimers();
  const attempts = [];
  let shouldFail = true;
  const queue = createKeyedDebouncer({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onEmit(key, value) {
      attempts.push([key, value]);
      if (shouldFail) return Promise.reject(new Error('disk full'));
      return Promise.resolve({ ok: true });
    }
  });

  queue.schedule('window.alwaysOnTop', false);
  await assert.rejects(queue.flush(), /disk full/);
  assert.equal(queue.hasPending(), true, 'the failed user value must remain retryable');

  shouldFail = false;
  await queue.flush();
  assert.deepEqual(attempts, [
    ['window.alwaysOnTop', false],
    ['window.alwaysOnTop', false]
  ]);
  assert.equal(queue.hasPending(), false);
});

test('acknowledged settings writer validates, applies side effects, and broadcasts once', () => {
  const { saveSetting } = loadSettingsWrite();
  const calls = [];
  const result = saveSetting({
    store: {
      set(key, value) {
        calls.push(['set', key, value]);
      }
    },
    applySetting(key, value) {
      calls.push(['apply', key, value]);
    },
    broadcastSettings() {
      calls.push(['broadcast']);
    }
  }, { key: 'window.darkMode', value: 'dark' });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    ['set', 'window.darkMode', 'dark'],
    ['apply', 'window.darkMode', 'dark'],
    ['broadcast']
  ]);
});

test('acknowledged settings writer rejects invalid keys before any write', () => {
  const { saveSetting } = loadSettingsWrite();
  const calls = [];
  const deps = {
    store: { set() { calls.push('set'); } },
    applySetting() { calls.push('apply'); },
    broadcastSettings() { calls.push('broadcast'); }
  };

  assert.throws(
    () => saveSetting(deps, { key: 'providers.deepseek.sessionToken', value: 'secret' }),
    /not writable/i
  );
  assert.deepEqual(calls, []);
});

test('acknowledged settings writer does not apply or broadcast after persistence fails', () => {
  const { saveSetting } = loadSettingsWrite();
  const calls = [];
  const deps = {
    store: { set() { throw new Error('write failed'); } },
    applySetting() { calls.push('apply'); },
    broadcastSettings() { calls.push('broadcast'); }
  };

  assert.throws(
    () => saveSetting(deps, { key: 'window.opacity', value: 70 }),
    /write failed/
  );
  assert.deepEqual(calls, []);
});

test('preload and main process expose one acknowledged settings save channel', () => {
  const preload = fs.readFileSync(
    path.resolve(__dirname, '../src/preload/preload.js'),
    'utf8'
  );
  const ipc = fs.readFileSync(
    path.resolve(__dirname, '../src/main/ipc.js'),
    'utf8'
  );

  assert.match(preload, /invoke:[\s\S]*?'settings:save'/);
  assert.match(ipc, /const \{ saveSetting \} = require\('\.\/core\/settings-write'\);/);
  assert.match(
    ipc,
    /ipcMain\.handle\('settings:save', \(event, payload\) => \{\s*return saveSetting\(deps, payload\);\s*\}\);/
  );
  assert.match(ipc, /ipcMain\.on\('settings:update'/, 'legacy dashboard writes must remain supported');
});

test('settings window waits for flush before close and keeps the window open on failure', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-window.js'),
    'utf8'
  );
  const html = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/settings-window.html'),
    'utf8'
  );

  assert.match(
    source,
    /onEmit:\s*function \(key, value\) \{\s*return window\.api\.invoke\('settings:save', \{ key: key, value: value \}\);\s*\}/
  );
  assert.match(source, /function requestSettingsClose\(\)/);
  assert.match(
    source,
    /settingsUpdateQueue\.flush\(\)\.then\(function \(\) \{\s*window\.api\.send\('window:close-settings'\);/
  );
  assert.match(
    source,
    /\.catch\(function \(\) \{[\s\S]*?showSaveError\('设置保存失败，请重试。'\);[\s\S]*?\}\);/
  );
  assert.match(
    source,
    /settingsCloseBtn[\s\S]*?addEventListener\('click', requestSettingsClose\)/
  );
  assert.match(
    source,
    /settingsDoneBtn[\s\S]*?addEventListener\('click', requestSettingsClose\)/
  );
  assert.match(html, /id="settingsSaveError"[^>]*role="alert"[^>]*hidden/);
});

test('settings save error remains visible while any failed key is still pending', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-window.js'),
    'utf8'
  );

  assert.match(source, /var failedSaveKeys = Object\.create\(null\);/);
  assert.match(
    source,
    /onSuccess:\s*function \(key\) \{\s*delete failedSaveKeys\[key\];\s*if \(Object\.keys\(failedSaveKeys\)\.length === 0\) \{\s*showSaveError\(''\);\s*\}\s*\}/
  );
  assert.match(
    source,
    /onError:\s*function \(error, key\) \{\s*failedSaveKeys\[key\] = true;\s*showSaveError\('设置保存失败，请重试。'\);\s*\}/
  );
});
