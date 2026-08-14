const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rescanLocalLogs } = require('../src/main/core/history-sync');
const dshProvider = require('../src/main/providers/dsh');

function makeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    get(key) {
      if (key === 'usageDaily') return data.usageDaily;
      if (key === 'usageDailyCost') return data.usageDailyCost;
      if (key === 'localLogCursors.dsh') return data.localLogCursors_dsh;
      if (key === 'data.historyDays') return data.historyDays;
      if (key === 'providers.dsh.telemetryRoot') return data.root;
      return undefined;
    },
    set(key, value) {
      // 与 electron-store/conf 语义一致:set(object) 一次应用多键(dsh 提交路径使用)。
      if (typeof key === 'object' && key !== null) {
        Object.keys(key).forEach((k) => this.set(k, key[k]));
        return;
      }
      if (key === 'usageDaily') data.usageDaily = JSON.parse(JSON.stringify(value));
      else if (key === 'usageDailyCost') data.usageDailyCost = JSON.parse(JSON.stringify(value));
      else if (key === 'localLogCursors.dsh') data.localLogCursors_dsh = JSON.parse(JSON.stringify(value));
      else data[key] = value;
    },
    delete(key) { delete data[key]; }
  };
}

test('rescanLocalLogs clears and rebuilds dsh usageDaily AND usageDailyCost transactionally', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rescan-'));
  const dayFile = 'usage-2026-08-14.jsonl';
  const dayPath = path.join(root, dayFile);
  fs.writeFileSync(dayPath,
    [
      JSON.stringify({ v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      JSON.stringify({ v: 1, time: Date.UTC(2026, 7, 14, 3, 0, 0), sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    ].join('\n') + '\n');

  const staleCursor = {
    offset: fs.statSync(dayPath).size,
    mtimeMs: fs.statSync(dayPath).mtimeMs,
    lastEventFingerprint: 'sha256:stale-end-of-file'
  };
  const store = makeStore({
    usageDaily: { 'dsh:2026-08-13': { input: 1, cached: 0, output: 1, total: 2 } },
    usageDailyCost: { 'dsh:2026-08-13': 0.004 },
    localLogCursors_dsh: { [dayPath]: staleCursor },
    root,
    historyDays: 30
  });

  const result = await rescanLocalLogs({
    providerId: 'dsh',
    readLocalLog: () => dshProvider.readLocalLog({ store }, { retainAll: true, nowMs: Date.UTC(2026, 7, 14, 4, 0, 0) }),
    readStore: (k) => store.get(k),
    writeStore: (k, v) => store.set(k, v),
    deleteStore: (k) => store.delete(k)
  });

  assert.equal(result.daysRebuilt, 1);
  const daily = store.get('usageDaily');
  assert.equal(daily['dsh:2026-08-14'].input, 1500);
  const cost = store.get('usageDailyCost');
  assert.equal(cost['dsh:2026-08-13'], undefined);
  assert.ok(cost['dsh:2026-08-14'] > 0);
  const cursors = store.get('localLogCursors.dsh');
  assert.equal(cursors[dayPath].offset, fs.statSync(dayPath).size);
  assert.notEqual(cursors[dayPath].lastEventFingerprint, staleCursor.lastEventFingerprint);
});

test('rescanLocalLogs restores usageDailyCost when the scan fails', async () => {
  const store = makeStore({
    usageDaily: { 'dsh:2026-08-13': { input: 1, cached: 0, output: 1, total: 2 } },
    usageDailyCost: { 'dsh:2026-08-13': 0.004 },
    root: path.join(os.tmpdir(), 'no-such-dsh-telemetry-dir-' + Date.now()),
    historyDays: 30
  });
  await assert.rejects(rescanLocalLogs({
    providerId: 'dsh',
    readLocalLog: async () => { throw new Error('boom'); },
    readStore: (k) => store.get(k),
    writeStore: (k, v) => store.set(k, v),
    deleteStore: (k) => store.delete(k)
  }), /boom/);
  assert.deepEqual(store.get('usageDailyCost'), { 'dsh:2026-08-13': 0.004 });
  assert.deepEqual(store.get('usageDaily'), { 'dsh:2026-08-13': { input: 1, cached: 0, output: 1, total: 2 } });
});
