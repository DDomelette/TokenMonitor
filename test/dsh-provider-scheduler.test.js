const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dshProvider = require('../src/main/providers/dsh');
const { startScheduler } = require('../src/main/core/scheduler');

function getPath(object, key) {
  return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
}
function setPath(object, key, value) {
  const parts = key.split('.');
  let current = object;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[0]] = value;
}
function makeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    get(key) { return getPath(data, key); },
    // 与 electron-store/conf 语义一致:set(object) 一次应用多键(dot 键写嵌套路径)。
    set(key, value) {
      if (typeof key === 'object' && key !== null) {
        Object.keys(key).forEach((k) => setPath(data, k, key[k]));
        return;
      }
      setPath(data, key, value);
    }
  };
}
function makeRegistry(providers) {
  return { list: () => providers.slice(), get: (id) => providers.find((p) => p.id === id) };
}

test('dsh adapter exposes the localLog contract', () => {
  assert.equal(dshProvider.id, 'dsh');
  assert.equal(dshProvider.displayName, 'DeepSeek Harness');
  assert.deepEqual(dshProvider.capabilities, { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false });
  assert.equal(dshProvider.authStatus({}), 'ok');
  assert.equal(typeof dshProvider.readLocalLog, 'function');
  const root = dshProvider.localLogRoot({ store: makeStore() });
  assert.ok(path.isAbsolute(root) && root.endsWith(path.join('.dsh', 'telemetry')));
});

test('scheduler polls dsh localLog and the merged daily lands in the store', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sched-'));
  fs.writeFileSync(path.join(root, 'usage-2026-08-14.jsonl'),
    JSON.stringify({ v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }) + '\n');

  const store = makeStore({ usageDaily: {}, providers: { dsh: { telemetryRoot: root } }, data: { historyDays: 30 } });
  const broadcasts = [];
  const scheduler = startScheduler({
    registry: makeRegistry([dshProvider]),
    store,
    broadcast(channel, payload) { broadcasts.push({ channel, payload }); },
    intervals: false
  });
  try {
    await scheduler.poll('dsh', 'localLog');
    const daily = store.get('usageDaily');
    assert.equal(daily['dsh:2026-08-14'].input, 100);
    assert.equal(daily['dsh:2026-08-14'].output, 200);
    assert.ok(store.get('usageDailyCost')['dsh:2026-08-14'] > 0);
    assert.ok(broadcasts.some((b) => b.channel === 'providers:changed'));
  } finally {
    scheduler.stop();
  }
});

test('scheduler collects dsh localLog parse diagnostics and logs them', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sched-'));
  fs.writeFileSync(path.join(root, 'usage-2026-08-14.jsonl'), 'not json\n');

  const store = makeStore({ usageDaily: {}, providers: { dsh: { telemetryRoot: root } }, data: { historyDays: 30 } });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  t.after(() => { console.warn = originalWarn; });

  const scheduler = startScheduler({
    registry: makeRegistry([dshProvider]),
    store,
    broadcast() {},
    intervals: false
  });
  try {
    await scheduler.poll('dsh', 'localLog');
    assert.ok(
      warnings.some((w) => w.includes('malformedLine=1')),
      'non-zero parse diagnostics must be logged, got: ' + JSON.stringify(warnings)
    );
  } finally {
    scheduler.stop();
  }
});

test('RESET_KEEP_KEYS preserves dsh aggregates and cursors across a settings reset', () => {
  const { RESET_KEEP_KEYS } = require('../src/main/core/settings-reset');
  assert.ok(RESET_KEEP_KEYS.includes('usageDailyCost'));
  assert.ok(RESET_KEEP_KEYS.includes('localLogCursors.dsh'));
});
