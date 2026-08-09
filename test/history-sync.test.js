const test = require('node:test');
const assert = require('node:assert/strict');
const { syncDeepSeekHistory, rescanLocalLogs } = require('../src/main/core/history-sync');

function makeStore(seed) {
  const data = Object.assign({}, seed);
  return { data, get(k) { return data[k]; }, set(k, v) { data[k] = v; } };
}
const noopSleep = async () => {};

// 2026-08 起 12 个连续空月:6..1(2026)+ 12..7(2025)
const TWELVE_EMPTY_CALLS = ['2026-6', '2026-5', '2026-4', '2026-3', '2026-2', '2026-1',
  '2025-12', '2025-11', '2025-10', '2025-9', '2025-8', '2025-7'];

test('逐月向前直到连续 12 个空月停止,同名键以 API 覆盖', async () => {
  const store = makeStore({ usageDaily: { 'deepseek:2026-08-01': { input: 0, cached: 0, output: 0, total: 1 } } });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (year === 2026 && month === 8) return [{ date: '2026-08-01', total: 100, cacheHit: 40, models: [{ model: 'm1', tokens: 100 }] }];
    if (year === 2026 && month === 7) return [{ date: '2026-07-15', total: 50, cacheHit: 0, models: [] }];
    return [];
  };
  const r = await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.deepEqual(calls, ['2026-8', '2026-7', ...TWELVE_EMPTY_CALLS]);
  assert.equal(store.data.usageDaily['deepseek:2026-08-01'].total, 100);
  assert.equal(store.data.usageDaily['deepseek:2026-08-01'].cached, 40);
  assert.deepEqual(store.data.usageDaily['deepseek:2026-08-01'].models, [{ model: 'm1', tokens: 100 }]);
  assert.equal(store.data.usageDaily['deepseek:2026-07-15'].total, 50);
  assert.equal(r.monthsFetched, 14);
  assert.deepEqual(r.monthsFailed, []);
  assert.equal(r.earliestDate, '2026-07-15');
  assert.equal(store.data['providers.deepseek.syncedMonths'].length, 14);
  assert.ok(store.data['providers.deepseek.syncedMonths'].includes('2026-08'));
  assert.ok(store.data['providers.deepseek.syncedMonths'].includes('2025-07'));
});

test('单月失败重试一次后跳过并计入 failed,流程不中断', async () => {
  const store = makeStore({});
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (year === 2026 && month === 7) throw new Error('network');
    if (year === 2026 && month === 8) return [{ date: '2026-08-01', total: 10, cacheHit: 0, models: [] }];
    return [];
  };
  const r = await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.deepEqual(calls, ['2026-8', '2026-7', '2026-7', ...TWELVE_EMPTY_CALLS]);
  assert.deepEqual(r.monthsFailed, ['2026-07']);
  assert.equal(r.monthsFetched, 13);
  assert.ok(!store.data['providers.deepseek.syncedMonths'].includes('2026-07'));
});

test('最多向前探测 36 个月', async () => {
  const store = makeStore({});
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    return [{ date: year + '-' + String(month).padStart(2, '0') + '-15', total: 1, cacheHit: 0, models: [] }];
  };
  await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.equal(calls.length, 36);
  assert.equal(calls[35], '2023-9');
});

test('已在 syncedMonths 中的月份直接跳过不重复请求', async () => {
  const store = makeStore({ 'providers.deepseek.syncedMonths': ['2026-08', '2026-07'] });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (year === 2026 && month === 6) return [{ date: '2026-06-17', total: 5, cacheHit: 0, models: [] }];
    return [];
  };
  const r = await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.deepEqual(calls, ['2026-6', '2026-5', '2026-4', '2026-3', '2026-2', '2026-1',
    '2025-12', '2025-11', '2025-10', '2025-9', '2025-8', '2025-7', '2025-6']);
  assert.equal(r.earliestDate, '2026-06-17');
});

// 回归:backfill 的 fetchedMonths 标记的月份,其数据可能已被保留窗口丢弃,
// 全量同步不得因此跳过(真实案例:4 月数据被 persistDaily 丢弃但月份已标 fetched)。
test('旧 fetchedMonths 标记不影响全量同步(4 月数据重新抓取)', async () => {
  const store = makeStore({
    'providers.deepseek.fetchedMonths': ['2026-08', '2026-07', '2026-06', '2026-05', '2026-04']
  });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (year === 2026 && month === 4) return [{ date: '2026-04-10', total: 33, cacheHit: 3, models: [] }];
    if (year === 2026 && month === 8) return [{ date: '2026-08-01', total: 10, cacheHit: 0, models: [] }];
    return [];
  };
  const r = await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.ok(calls.includes('2026-4'), '4 月必须重新请求,实际 calls: ' + calls.join(','));
  assert.equal(store.data.usageDaily['deepseek:2026-04-10'].total, 33);
  assert.equal(r.earliestDate, '2026-04-10');
});

test('重扫:清该 provider 前缀键与游标,循环扫描直到无新增,覆盖同名键', async () => {
  const store = makeStore({
    usageDaily: {
      'codex:2026-06-17': { input: 0, cached: 0, output: 0, total: 999 },
      'kimi:2026-06-17': { input: 0, cached: 0, output: 0, total: 5 }
    },
    'localLogCursors.codex': { '/x/rollout-a.jsonl': { offset: 123, mtimeMs: 1 } }
  });
  let pass = 0;
  const readLocalLog = async () => {
    pass++;
    if (pass === 1) {
      store.data.usageDaily['codex:2026-06-17'] = { input: 10, cached: 0, output: 40, total: 50 };
      store.data.usageDaily['codex:2026-06-18'] = { input: 1, cached: 0, output: 1, total: 2 };
      return [{}, {}];
    }
    return [];
  };
  const r = await rescanLocalLogs({
    providerId: 'codex', readLocalLog, readStore: store.get, writeStore: store.set
  });
  assert.equal(store.data.usageDaily['codex:2026-06-17'].total, 50);
  assert.equal(store.data.usageDaily['kimi:2026-06-17'].total, 5);
  assert.deepEqual(store.data['localLogCursors.codex'], {});
  assert.equal(r.daysRebuilt, 2);
  assert.equal(r.earliestDate, '2026-06-17');
  assert.equal(r.passes, 2);
  assert.equal(r.records, 2);
});

test('重扫:日志为空时 daysRebuilt=0,不视为错误', async () => {
  const store = makeStore({});
  const readLocalLog = async () => [];
  const r = await rescanLocalLogs({
    providerId: 'kimi', readLocalLog, readStore: store.get, writeStore: store.set
  });
  assert.equal(r.daysRebuilt, 0);
  assert.equal(r.earliestDate, null);
  assert.equal(r.passes, 1);
});

test('日边界:rollupDaily 聚合键为本地(北京)日历日', () => {
  const { rollupDaily } = require('../src/main/core/locallog');
  const ts = Date.UTC(2026, 5, 17, 16, 30); // UTC 16:30,北京时间为次日 00:30
  ['codex', 'kimi'].forEach((pid) => {
    const daily = rollupDaily([{ provider: pid, ts, usage: { input: 1, cached: 0, output: 1, total: 2 } }]);
    const d = new Date(ts);
    const key = pid + ':' + d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    assert.ok(daily[key], pid + ' 应按本地日历日聚合,实际键:' + Object.keys(daily).join(','));
  });
});
