const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const {
  parseTelemetryLine,
  resolveTelemetryRoot,
  readLocalLog,
  DEFAULT_ROOT,
  MATCH
} = require('../src/main/providers/dsh/telemetrylog');

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingMs(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS;
}

const LINE = JSON.stringify({
  v: 1, time: 1786641087069, sessionId: 'session-1', cwd: 'D:\\Deepseek_Monitor',
  model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 2000,
  cacheReadTokens: 3000, cacheWriteTokens: 100
});

test('parseTelemetryLine maps the four buckets into the UsageRecord shape', () => {
  const diagnostics = {};
  const rec = parseTelemetryLine(LINE, diagnostics, Date.now());
  assert.ok(rec);
  assert.equal(rec.ts, 1786641087069);
  assert.equal(rec.model, 'deepseek-v4-pro');
  assert.deepEqual(rec.usage, { input: 1100, cached: 3000, output: 2000, total: 6100 });
  assert.ok(typeof rec.cost === 'number' && rec.cost > 0);
  assert.match(rec.eventFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('parseTelemetryLine prices historical rows using the row time', () => {
  const time = beijingMs(2026, 8, 16, 23, 59);
  const record = parseTelemetryLine(JSON.stringify({
    v: 1,
    time,
    sessionId: 's-price',
    model: 'deepseek-v4-pro',
    inputTokens: 1000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  }), {}, time);
  assert.equal(record.cost, 0.003);
});

test('parseTelemetryLine rejects malformed rows with diagnostics', () => {
  const diagnostics = {};
  assert.equal(parseTelemetryLine('not json', diagnostics, Date.now()), null);
  assert.equal(diagnostics.malformedLine, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ v: 2, time: 1, sessionId: 's', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.unknownRowVersion, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ time: 1, sessionId: 's', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.missingRowVersion, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ v: 1, time: 'yesterday', sessionId: 's', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.invalidTimestamp, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ v: 1, time: 1786641087069, sessionId: 's', inputTokens: -1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.invalidTokenCount, 1);
});

test('parseTelemetryLine defaults a missing model to unknown and zeroes missing cache buckets', () => {
  const rec = parseTelemetryLine(JSON.stringify({ v: 1, time: 1786641087069, sessionId: 's', inputTokens: 5, outputTokens: 6 }), {}, Date.now());
  assert.ok(rec);
  assert.equal(rec.model, 'unknown');
  assert.deepEqual(rec.usage, { input: 5, cached: 0, output: 6, total: 11 });
});

test('parseTelemetryLine rejects coercible token values and missing session identity', () => {
  const base = {
    v: 1,
    time: 1786641087069,
    sessionId: 'session-1',
    model: 'deepseek-v4-pro',
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4
  };
  const cases = [
    [{ ...base, time: String(base.time) }, 'invalidTimestamp'],
    [{ ...base, sessionId: null }, 'invalidSessionId'],
    [{ ...base, sessionId: '' }, 'invalidSessionId'],
    [{ ...base, inputTokens: null }, 'invalidTokenCount'],
    [{ ...base, inputTokens: '1' }, 'invalidTokenCount'],
    [{ ...base, outputTokens: true }, 'invalidTokenCount'],
    [{ ...base, cacheReadTokens: false }, 'invalidTokenCount'],
    [{ ...base, cacheWriteTokens: '4' }, 'invalidTokenCount'],
    [{ ...base, model: 7 }, 'invalidModel'],
    [{ ...base, cwd: 7 }, 'invalidCwd']
  ];
  cases.forEach(([row, diagnostic]) => {
    const diagnostics = {};
    assert.equal(parseTelemetryLine(JSON.stringify(row), diagnostics, Date.now()), null);
    assert.equal(diagnostics[diagnostic], 1);
  });
});

test('parseTelemetryLine requires input/output but defaults only absent cache buckets', () => {
  const base = { v: 1, time: 1786641087069, sessionId: 's' };
  const missingInputDiagnostics = {};
  assert.equal(
    parseTelemetryLine(JSON.stringify({ ...base, outputTokens: 1 }), missingInputDiagnostics, Date.now()),
    null
  );
  assert.equal(missingInputDiagnostics.invalidTokenCount, 1);

  const record = parseTelemetryLine(
    JSON.stringify({ ...base, inputTokens: 5, outputTokens: 6 }),
    {},
    Date.now()
  );
  assert.deepEqual(record.usage, { input: 5, cached: 0, output: 6, total: 11 });
});

test('eventFingerprint includes sessionId and model so identical ms+buckets rows differ', () => {
  const base = { v: 1, time: 1786641087069, model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 100 };
  const a = parseTelemetryLine(JSON.stringify({ ...base, sessionId: 'session-a' }), {}, Date.now());
  const b = parseTelemetryLine(JSON.stringify({ ...base, sessionId: 'session-b' }), {}, Date.now());
  const c = parseTelemetryLine(JSON.stringify({ ...base, sessionId: 'session-a', model: 'deepseek-v5' }), {}, Date.now());
  assert.ok(a && b && c);
  assert.notEqual(a.eventFingerprint, b.eventFingerprint);
  assert.notEqual(a.eventFingerprint, c.eventFingerprint);
});

test('resolveTelemetryRoot precedence: setting > DSH_HOME env > ~/.dsh/telemetry', () => {
  const nativeDshHome = path.resolve('test-fixtures', 'dsh-home');
  const nativeCustomRoot = path.resolve('test-fixtures', 'custom-telemetry');
  assert.equal(resolveTelemetryRoot(null, {}), path.join(os.homedir(), '.dsh', 'telemetry'));
  assert.equal(
    resolveTelemetryRoot(null, { DSH_HOME: nativeDshHome }),
    path.join(nativeDshHome, 'telemetry')
  );
  const store = {
    get: (key) => key === 'providers.dsh.telemetryRoot' ? nativeCustomRoot : undefined
  };
  assert.equal(resolveTelemetryRoot(store, { DSH_HOME: nativeDshHome }), nativeCustomRoot);
  assert.equal(resolveTelemetryRoot(null, { DSH_HOME: path.join('.', 'dsh') }), path.resolve('dsh', 'telemetry'));
  assert.equal(resolveTelemetryRoot({ get: () => ' ' }, { DSH_HOME: ' ' }), DEFAULT_ROOT());
});

test('resolveTelemetryRoot expands tilde and resolves relative DSH_HOME like the DSH producer', () => {
  // DSH 生产者 resolveDshHome 对 $DSH_HOME 做 expandHomePath(~ 前缀) + resolve 绝对化;
  // 消费者必须等价处理,否则 DSH_HOME=~/dsh 或相对路径时两边指向不同目录、静默无数据。
  assert.equal(resolveTelemetryRoot(null, { DSH_HOME: '~/dsh' }), path.join(os.homedir(), 'dsh', 'telemetry'));
  assert.equal(resolveTelemetryRoot(null, { DSH_HOME: path.join('.', 'dsh') }), path.resolve('dsh', 'telemetry'));
});

test('resolveTelemetryRoot expands tilde for the custom telemetryRoot setting', () => {
  const store = { get: (key) => key === 'providers.dsh.telemetryRoot' ? '~/custom-telemetry' : undefined };
  assert.equal(resolveTelemetryRoot(store, { DSH_HOME: path.resolve('test-fixtures', 'dsh-home') }), path.join(os.homedir(), 'custom-telemetry'));
});

test('MATCH accepts only usage-YYYY-MM-DD.jsonl names', () => {
  assert.ok(MATCH.test('usage-2026-08-14.jsonl'));
  assert.ok(!MATCH.test('usage-2026-08-14.jsonl.tmp'));
  assert.ok(!MATCH.test('usage.jsonl'));
  assert.ok(!MATCH.test('usage-2026-13-99.jsonl'));
});

/* ======== readLocalLog 扫描与聚合 ======== */
const fs = require('node:fs');

function makeStore(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
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

function writeRows(root, dayFile, rows) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, dayFile), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

test('readLocalLog merges usageDaily and usageDailyCost from the day file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  writeRows(root, 'usage-2026-08-14.jsonl', [
    { v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 100 },
    { v: 1, time: Date.UTC(2026, 7, 14, 3, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  ]);
  const store = makeStore({ usageDaily: {}, providers: { dsh: { telemetryRoot: root } }, data: { historyDays: 30 } });
  const { readLocalLog } = require('../src/main/providers/dsh/telemetrylog');
  const batch = await readLocalLog({ store }, { nowMs: Date.UTC(2026, 7, 14, 4, 0, 0) });

  assert.equal(batch.records.length, 2);
  assert.equal(batch.complete, true);
  const daily = store.get('usageDaily');
  const row = daily['dsh:2026-08-14'];
  assert.equal(row.input, 1100 + 500);
  assert.equal(row.cached, 3000);
  assert.equal(row.output, 2000);
  assert.equal(row.total, 6100 + 500);
  assert.ok(store.get('usageDailyCost')['dsh:2026-08-14'] > 0);
});

test('readLocalLog commits via the electron-store snapshot path and preserves unrelated keys', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const dayFile = 'usage-2026-08-14.jsonl';
  writeRows(root, dayFile, [
    { v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 100 }
  ]);
  const { readLocalLog } = require('../src/main/providers/dsh/telemetrylog');

  // electron-store 形态:store.store 是快照,get/set 读写快照;commitTelemetryScanState 的
  // 快照路径通过整体替换 store.store 原子提交(真实生产路径,区别于 get/set-only 退化路径)。
  const store = {
    store: JSON.parse(JSON.stringify({
      usageDaily: {},
      usageDailyCost: {},
      localLogCursors: {
        codex: { 'C:\\codex-sessions': { offset: 7, mtimeMs: 1 } },
        kimi: { 'C:\\kimi-sessions': { offset: 9, mtimeMs: 2 } }
      },
      providers: { dsh: { telemetryRoot: root } },
      data: { historyDays: 30 },
      unrelatedKey: { keep: true }
    })),
    get(key) {
      return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), this.store);
    },
    set(key, value) {
      const parts = key.split('.');
      let current = this.store;
      while (parts.length > 1) {
        const part = parts.shift();
        if (!current[part] || typeof current[part] !== 'object') current[part] = {};
        current = current[part];
      }
      current[parts[0]] = value;
    }
  };

  await readLocalLog({ store }, { nowMs: Date.UTC(2026, 7, 14, 4, 0, 0) });

  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].input, 1100);
  assert.ok(store.get('usageDailyCost')['dsh:2026-08-14'] > 0);
  const cursors = store.get('localLogCursors.dsh');
  assert.ok(cursors && typeof cursors === 'object');
  const fileKeys = Object.keys(cursors);
  assert.ok(fileKeys.length >= 1 && fileKeys.some((k) => k.endsWith(dayFile)));
  assert.ok(fileKeys.every((k) => cursors[k] && cursors[k].offset > 0));
  assert.deepEqual(store.get('unrelatedKey'), { keep: true });
  // 其他 provider 的游标必须原样保留(dsh 快照提交只合并 localLogCursors.dsh)
  assert.deepEqual(store.get('localLogCursors.codex'), { 'C:\\codex-sessions': { offset: 7, mtimeMs: 1 } });
  assert.deepEqual(store.get('localLogCursors.kimi'), { 'C:\\kimi-sessions': { offset: 9, mtimeMs: 2 } });
});

test('readLocalLog rescans incrementally: failed commit restores data and the re-read merges exactly once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const dayFile = 'usage-2026-08-14.jsonl';
  writeRows(root, dayFile, [
    { v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }
  ]);
  const store = makeStore({ usageDaily: {}, providers: { dsh: { telemetryRoot: root } }, data: { historyDays: 30 } });
  const { readLocalLog } = require('../src/main/providers/dsh/telemetrylog');
  const now = Date.UTC(2026, 7, 14, 4, 0, 0);

  await readLocalLog({ store }, { nowMs: now });
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].input, 100);

  // 追加一行;随后一次游标提交失败的扫描必须既不落数据也不落游标(原子回滚)。
  fs.appendFileSync(path.join(root, dayFile), JSON.stringify({ v: 1, time: Date.UTC(2026, 7, 14, 2, 30, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 200, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }) + '\n');

  const failing = makeStore({
    usageDaily: store.get('usageDaily'),
    usageDailyCost: store.get('usageDailyCost'),
    providers: { dsh: { telemetryRoot: root } },
    data: { historyDays: 30 }
  });
  const realSet = failing.set.bind(failing);
  failing.set = function (key, value) {
    // 回退提交路径是单次多键 set(object):游标键在其中即整体失败,且不落任何键。
    if (typeof key === 'object' && key !== null && Object.prototype.hasOwnProperty.call(key, 'localLogCursors.dsh')) {
      throw new Error('cursor commit failed');
    }
    realSet(key, value);
  };
  await assert.rejects(readLocalLog({ store: failing }, { nowMs: now }), /cursor commit failed/);
  assert.equal(failing.get('usageDaily')['dsh:2026-08-14'].input, 100);

  // 正常 store 重扫:重读被回滚的那一行,恰好合并一次,不双计。
  const batch = await readLocalLog({ store }, { nowMs: now });
  assert.equal(batch.records.length, 1);
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].input, 300);
  // 再扫一轮:无新行。
  const batch3 = await readLocalLog({ store }, { nowMs: now });
  assert.equal(batch3.records.length, 0);
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].input, 300);
});

/* ======== M1: 空扫描不无条件提交 ======== */

// electron-store 形态快照 store:store.store 赋值 = 一次整体提交(计数 writes)。
function makeSnapshotStore(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  const store = {
    writes: 0,
    get(key) {
      return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), data);
    },
    set(key, value) {
      const parts = key.split('.');
      let current = data;
      while (parts.length > 1) {
        const part = parts.shift();
        if (!current[part] || typeof current[part] !== 'object') current[part] = {};
        current = current[part];
      }
      current[parts[0]] = value;
    }
  };
  Object.defineProperty(store, 'store', {
    get() { return data; },
    set(value) {
      store.writes += 1;
      Object.keys(data).forEach((k) => delete data[k]);
      Object.assign(data, value);
    }
  });
  return store;
}

test('readLocalLog skips the store commit entirely when root is missing and no cursors exist', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const { readLocalLog } = require('../src/main/providers/dsh/telemetrylog');
  const store = makeSnapshotStore({
    usageDaily: {},
    usageDailyCost: {},
    providers: { dsh: { telemetryRoot: root } },
    data: { historyDays: 30 }
  });
  const batch = await readLocalLog({ store }, { nowMs: Date.UTC(2026, 7, 14, 4, 0, 0) });
  assert.equal(batch.records.length, 0);
  assert.equal(batch.complete, true);
  assert.equal(store.writes, 0, 'empty scan without cursors must not rewrite the store');
  assert.deepEqual(store.get('usageDaily'), {});
});

test('readLocalLog preserves cursors when a previously scanned file is absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const missing = path.join(root, 'usage-2026-08-10.jsonl');
  const cursor = { offset: 42, mtimeMs: 1, lastEventFingerprint: 'sha256:old' };
  const store = makeSnapshotStore({
    usageDaily: {},
    usageDailyCost: {},
    localLogCursors: { dsh: { [missing]: cursor } },
    providers: { dsh: { telemetryRoot: root } },
    data: { historyDays: 30 }
  });
  const batch = await readLocalLog({ store }, { nowMs: Date.UTC(2026, 7, 14, 4) });
  assert.equal(batch.records.length, 0);
  assert.equal(store.writes, 0);
  assert.deepEqual(store.get('localLogCursors.dsh'), { [missing]: cursor });
});

test('a telemetry root disappearing and returning does not double-count prior rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const offlineRoot = root + '-offline';
  const dayFile = 'usage-2026-08-14.jsonl';
  writeRows(root, dayFile, [{
    v: 1,
    time: Date.UTC(2026, 7, 14, 2),
    sessionId: 's1',
    model: 'deepseek-v4-pro',
    inputTokens: 100,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  }]);
  const store = makeStore({
    usageDaily: {},
    usageDailyCost: {},
    providers: { dsh: { telemetryRoot: root } },
    data: { historyDays: 30 }
  });
  const options = { nowMs: Date.UTC(2026, 7, 14, 4) };

  await readLocalLog({ store }, options);
  const firstCursor = JSON.parse(JSON.stringify(store.get('localLogCursors.dsh')));
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].total, 100);

  fs.renameSync(root, offlineRoot);
  try {
    await readLocalLog({ store }, options);
    assert.deepEqual(store.get('localLogCursors.dsh'), firstCursor);
  } finally {
    fs.renameSync(offlineRoot, root);
  }

  await readLocalLog({ store }, options);
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].total, 100);
});

test('readLocalLog commits to advance cursors even when every line is malformed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const dayFile = 'usage-2026-08-14.jsonl';
  fs.writeFileSync(path.join(root, dayFile), 'not json\nalso not json\n');
  const { readLocalLog } = require('../src/main/providers/dsh/telemetrylog');
  const store = makeSnapshotStore({
    usageDaily: {},
    usageDailyCost: {},
    providers: { dsh: { telemetryRoot: root } },
    data: { historyDays: 30 }
  });
  const diagnostics = {};
  const batch = await readLocalLog({ store }, { nowMs: Date.UTC(2026, 7, 14, 4, 0, 0), diagnostics });
  assert.equal(batch.records.length, 0);
  assert.equal(diagnostics.malformedLine, 2);
  assert.equal(store.writes, 1, 'cursor advance without records must still be committed');
  const cursors = store.get('localLogCursors.dsh');
  const fileKey = Object.keys(cursors).find((k) => k.endsWith(dayFile));
  assert.ok(fileKey, 'cursor must be recorded for the malformed file');
  assert.equal(cursors[fileKey].offset, fs.statSync(path.join(root, dayFile)).size);
});

test('fallback commit path applies all three keys in a single set call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  writeRows(root, 'usage-2026-08-14.jsonl', [
    { v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }
  ]);
  const { readLocalLog } = require('../src/main/providers/dsh/telemetrylog');
  const store = makeStore({ usageDaily: {}, providers: { dsh: { telemetryRoot: root } }, data: { historyDays: 30 } });
  const setCalls = [];
  const realSet = store.set.bind(store);
  store.set = function (key, value) { setCalls.push(key); realSet(key, value); };

  await readLocalLog({ store }, { nowMs: Date.UTC(2026, 7, 14, 4, 0, 0) });

  const objectCalls = setCalls.filter((key) => typeof key === 'object' && key !== null);
  assert.equal(objectCalls.length, 1, 'fallback commit must be a single multi-key set');
  assert.deepEqual(Object.keys(objectCalls[0]).sort(), ['localLogCursors.dsh', 'usageDaily', 'usageDailyCost']);
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].input, 100);
  assert.ok(store.get('usageDailyCost')['dsh:2026-08-14'] > 0);
  assert.ok(store.get('localLogCursors.dsh') && Object.keys(store.get('localLogCursors.dsh')).length >= 1);
});

test('fallback commit failure is rolled back by a single multi-key set restoring all three keys', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  writeRows(root, 'usage-2026-08-14.jsonl', [
    { v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }
  ]);
  const { readLocalLog } = require('../src/main/providers/dsh/telemetrylog');
  const store = makeStore({
    usageDaily: { 'dsh:2026-08-14': { input: 100, cached: 0, output: 0, total: 100 } },
    usageDailyCost: { 'dsh:2026-08-14': 0.1 },
    providers: { dsh: { telemetryRoot: root } },
    data: { historyDays: 30 }
  });
  const calls = [];
  const realSet = store.set.bind(store);
  let failCommit = true;
  store.set = function (key, value) {
    calls.push(key);
    if (failCommit && typeof key === 'object' && key !== null) {
      failCommit = false;
      throw new Error('commit failed');
    }
    realSet(key, value);
  };

  await assert.rejects(readLocalLog({ store }, { nowMs: Date.UTC(2026, 7, 14, 4, 0, 0) }), /commit failed/);

  const objectCalls = calls.filter((key) => typeof key === 'object' && key !== null);
  assert.equal(objectCalls.length, 2, 'one failed commit set plus one restore set');
  assert.deepEqual(Object.keys(objectCalls[0]).sort(), ['localLogCursors.dsh', 'usageDaily', 'usageDailyCost']);
  assert.deepEqual(Object.keys(objectCalls[1]).sort(), ['localLogCursors.dsh', 'usageDaily', 'usageDailyCost']);
  // 三键全部还原到提交前状态
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].input, 100);
  assert.equal(store.get('usageDailyCost')['dsh:2026-08-14'], 0.1);
  assert.deepEqual(store.get('localLogCursors.dsh'), {}, 'cursors restored to the pre-commit state');
});

test('parseTelemetryLine counts an unknownModel diagnostic and zeroes cost for unknown models', () => {
  const diagnostics = {};
  const known = parseTelemetryLine(JSON.stringify({ v: 1, time: 1786641087069, sessionId: 's', model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now());
  assert.ok(known && known.cost > 0);

  const unknown = parseTelemetryLine(JSON.stringify({ v: 1, time: 1786641087069, sessionId: 's', model: 'some-future-model', inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now());
  assert.ok(unknown);
  assert.equal(unknown.cost, 0);
  assert.equal(diagnostics.unknownModel, 1);

  // 缺失 model(回退 'unknown')同样按未知模型处理
  const missing = parseTelemetryLine(JSON.stringify({ v: 1, time: 1786641087069, sessionId: 's', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now());
  assert.equal(missing.cost, 0);
  assert.equal(diagnostics.unknownModel, 2);
});

test('scanTelemetryBatch skips a re-read line via cursor.lastEventFingerprint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const dayFile = 'usage-2026-08-14.jsonl';
  const row = { v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
  writeRows(root, dayFile, [row]);
  const filePath = path.join(root, dayFile);
  // 模拟"行已发射但游标未前进"的崩溃残留:offset 0 + 该行指纹。
  const { parseTelemetryLine } = require('../src/main/providers/dsh/telemetrylog');
  const fingerprint = parseTelemetryLine(JSON.stringify(row), {}, Date.now()).eventFingerprint;
  const store = makeStore({
    localLogCursors: { dsh: { [filePath]: { offset: 0, mtimeMs: fs.statSync(filePath).mtimeMs, lastEventFingerprint: fingerprint } } },
    providers: { dsh: { telemetryRoot: root } },
    data: { historyDays: 30 }
  });
  const diagnostics = {};
  const { readLocalLog } = require('../src/main/providers/dsh/telemetrylog');
  const batch = await readLocalLog({ store }, { nowMs: Date.UTC(2026, 7, 14, 4, 0, 0), diagnostics });
  assert.equal(batch.records.length, 0);
  assert.equal(diagnostics.duplicateEvent, 1);
});
