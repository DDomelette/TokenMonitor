const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const {
  parseTelemetryLine,
  resolveTelemetryRoot,
  DEFAULT_ROOT,
  MATCH
} = require('../src/main/providers/dsh/telemetrylog');

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
  assert.equal(resolveTelemetryRoot(null, {}), path.join(os.homedir(), '.dsh', 'telemetry'));
  assert.equal(resolveTelemetryRoot(null, { DSH_HOME: 'D:\\dsh-home' }), path.join('D:\\dsh-home', 'telemetry'));
  const store = { get: (key) => key === 'providers.dsh.telemetryRoot' ? 'D:\\custom' : undefined };
  assert.equal(resolveTelemetryRoot(store, { DSH_HOME: 'D:\\dsh-home' }), 'D:\\custom');
  assert.equal(resolveTelemetryRoot({ get: () => ' ' }, { DSH_HOME: ' ' }), DEFAULT_ROOT());
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
    set(key, value) { setPath(data, key, value); }
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
    if (key === 'localLogCursors.dsh') throw new Error('cursor commit failed');
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
