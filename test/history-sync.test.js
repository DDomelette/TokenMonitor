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
  // 数据月进 syncedMonths,空月进 syncedEmptyMonths(标记必须与数据共存才可信)
  assert.deepEqual(store.data['providers.deepseek.syncedMonths'].sort(), ['2026-07', '2026-08']);
  assert.equal(store.data['providers.deepseek.syncedEmptyMonths'].length, 12);
  assert.ok(store.data['providers.deepseek.syncedEmptyMonths'].includes('2025-07'));
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

test('已在 syncedMonths 且数据仍在的月份直接跳过不重复请求', async () => {
  const store = makeStore({
    'providers.deepseek.syncedMonths': ['2026-08', '2026-07'],
    usageDaily: {
      'deepseek:2026-08-01': { input: 0, cached: 0, output: 0, total: 10 },
      'deepseek:2026-07-15': { input: 0, cached: 0, output: 0, total: 50 }
    }
  });
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

// 回归(2026-08 真实案例):syncedMonths 标记了 2023-09 起全部月份,但保留窗口
// 清理把 7 月之前的日数据物理删除,重同步只信标记全部跳过,历史永久缺失。
// 标记必须与数据共存才可信:标记在但数据不在 => 重新抓取。
test('syncedMonths 标记在但数据已被清理的月份必须重新抓取', async () => {
  const store = makeStore({
    'providers.deepseek.syncedMonths': ['2026-08', '2026-07', '2026-06'],
    usageDaily: { 'deepseek:2026-08-01': { input: 0, cached: 0, output: 0, total: 10 } }
  });
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
  // 2026-08 标记+数据都在 => 跳过;2026-07/06 只有标记 => 重抓
  assert.ok(calls.includes('2026-7'), '2026-07 标记在但数据缺失,必须重抓,calls: ' + calls.join(','));
  assert.ok(calls.includes('2026-6'), '2026-06 标记在但数据缺失,必须重抓,calls: ' + calls.join(','));
  assert.ok(!calls.includes('2026-8'), '2026-08 标记与数据都在,不应重抓,calls: ' + calls.join(','));
  assert.equal(store.data.usageDaily['deepseek:2026-06-17'].total, 5);
  // 2026-07 抓回为空 => 移入空月集并移出数据月标记
  assert.ok(store.data['providers.deepseek.syncedEmptyMonths'].includes('2026-07'));
  assert.ok(!store.data['providers.deepseek.syncedMonths'].includes('2026-07'));
  assert.equal(r.earliestDate, '2026-06-17');
});

// 回归(2026-08 真实案例二):7 月 1-12 日被旧 30 天窗口清掉、7 月 13 日起数据还在,
// "标记+有数据"导致整月可信被跳过,上旬永久显示 0(平台侧其实每天都有用量)。
// 信任必须再加一条:该月的覆盖范围(同步时的窗口起点)不晚于当前窗口起点;
// 无覆盖记录的老标记用"现存最早日"兜底推断。
test('部分被清理的月份(标记+部分数据)在窗口调大后必须重抓补洞', async () => {
  const store = makeStore({
    'data.historyDays': 365,
    'providers.deepseek.syncedMonths': ['2026-08', '2026-07'],
    usageDaily: {
      'deepseek:2026-08-01': { input: 0, cached: 0, output: 0, total: 10 },
      'deepseek:2026-07-13': { input: 0, cached: 0, output: 0, total: 20 }
    }
  });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (year === 2026 && month === 7) {
      return [
        { date: '2026-07-01', total: 30, cacheHit: 0, models: [] },
        { date: '2026-07-13', total: 21, cacheHit: 0, models: [] }
      ];
    }
    return [];
  };
  await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-10T12:00:00', sleep: noopSleep
  });
  // 窗口起点 2025-08-11;2026-07 现存最早日 07-13 晚于起点 => 覆盖不足 => 重抓
  assert.ok(calls.includes('2026-7'), '7 月覆盖不足必须重抓,calls: ' + calls.join(','));
  assert.ok(!calls.includes('2026-8'), '8 月数据从 08-01 起完整,不应重抓,calls: ' + calls.join(','));
  assert.equal(store.data.usageDaily['deepseek:2026-07-01'].total, 30, '上旬空洞必须补上');
  assert.equal(store.data.usageDaily['deepseek:2026-07-13'].total, 21, '同名键以 API 覆盖');
  // 重抓后记录覆盖范围为当前窗口起点
  const coverage = store.data['providers.deepseek.syncedCoverage'];
  assert.equal(coverage['2026-07'], '2025-08-11');
});

// 覆盖范围不晚于当前窗口起点的月份直接跳过( syncedCoverage 显式记录 )
test('syncedCoverage 覆盖充足的月份直接跳过', async () => {
  const store = makeStore({
    'data.historyDays': 365,
    'providers.deepseek.syncedMonths': ['2026-08', '2026-07'],
    'providers.deepseek.syncedCoverage': { '2026-08': 'FULL', '2026-07': '2025-08-11' },
    usageDaily: {
      'deepseek:2026-08-01': { input: 0, cached: 0, output: 0, total: 10 },
      'deepseek:2026-07-13': { input: 0, cached: 0, output: 0, total: 20 }
    }
  });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    return [];
  };
  await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-10T12:00:00', sleep: noopSleep
  });
  assert.ok(!calls.includes('2026-8'), 'FULL 覆盖的 8 月不应重抓,calls: ' + calls.join(','));
  assert.ok(!calls.includes('2026-7'), '覆盖到 2025-08-11 的 7 月不应重抓,calls: ' + calls.join(','));
});

// 空月也有覆盖语义:旧窗口下抓为空并记录的月份,窗口调大后可能其实有数据,必须重抓
test('空月覆盖不足(窗口调大)时重抓并可翻转为数据月', async () => {
  const store = makeStore({
    'data.historyDays': 365,
    'providers.deepseek.syncedEmptyMonths': ['2026-07'],
    'providers.deepseek.syncedCoverage': { '2026-07': '2026-07-09' },
    usageDaily: { 'deepseek:2026-08-01': { input: 0, cached: 0, output: 0, total: 10 } },
    'providers.deepseek.syncedMonths': ['2026-08']
  });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (year === 2026 && month === 7) return [{ date: '2026-07-05', total: 8, cacheHit: 0, models: [] }];
    return [];
  };
  await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-10T12:00:00', sleep: noopSleep
  });
  assert.ok(calls.includes('2026-7'), '空月覆盖只到 07-09,窗口起点 2025-08-11,必须重抓,calls: ' + calls.join(','));
  assert.equal(store.data.usageDaily['deepseek:2026-07-05'].total, 8);
  assert.ok(store.data['providers.deepseek.syncedMonths'].includes('2026-07'), '翻转回数据月');
  assert.ok(!store.data['providers.deepseek.syncedEmptyMonths'].includes('2026-07'));
});

// 空月覆盖充足(显式记录不晚于当前窗口起点)时直接跳过
test('syncedCoverage 覆盖充足的空月直接跳过', async () => {
  const store = makeStore({
    'data.historyDays': 365,
    'providers.deepseek.syncedEmptyMonths': ['2026-07'],
    'providers.deepseek.syncedCoverage': { '2026-07': '2025-08-11' },
    usageDaily: { 'deepseek:2026-08-01': { input: 0, cached: 0, output: 0, total: 10 } },
    'providers.deepseek.syncedMonths': ['2026-08']
  });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    return [];
  };
  await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-10T12:00:00', sleep: noopSleep
  });
  assert.ok(!calls.includes('2026-7'), '覆盖充足的空月不应重抓,calls: ' + calls.join(','));
});

// 空月单独记录:真正抓过且为空的月份下次直接跳过(与"数据被清"区分开)
test('syncedEmptyMonths 中的空月直接跳过不重复请求', async () => {
  const store = makeStore({
    'providers.deepseek.syncedEmptyMonths': ['2026-07', '2026-06'],
    usageDaily: { 'deepseek:2026-08-01': { input: 0, cached: 0, output: 0, total: 10 } },
    'providers.deepseek.syncedMonths': ['2026-08']
  });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (year === 2026 && month === 5) return [{ date: '2026-05-10', total: 7, cacheHit: 0, models: [] }];
    return [];
  };
  await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.ok(!calls.includes('2026-7'), '空月 2026-07 不应重抓,calls: ' + calls.join(','));
  assert.ok(!calls.includes('2026-6'), '空月 2026-06 不应重抓,calls: ' + calls.join(','));
  assert.ok(calls.includes('2026-5'), '2026-05 无任何标记,应抓取,calls: ' + calls.join(','));
});

// 保留窗口过滤:整月落在窗口外的月份不抓不标记(窗口调大后仍可补抓);
// 部分在窗口内的月份只持久化窗口内的日数据。
test('保留窗口外的月份不抓取,窗口边界月只保留窗口内的日数据', async () => {
  const store = makeStore({ 'data.historyDays': 30 });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (year === 2026 && month === 8) return [{ date: '2026-08-01', total: 10, cacheHit: 0, models: [] }];
    if (year === 2026 && month === 7) {
      return [
        { date: '2026-07-01', total: 99, cacheHit: 0, models: [] },
        { date: '2026-07-15', total: 50, cacheHit: 0, models: [] }
      ];
    }
    return [{ date: '2026-06-15', total: 1, cacheHit: 0, models: [] }];
  };
  const r = await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  // 保留 30 天 => 窗口起点 2026-07-09;2026-06 整月在窗口外,循环到此终止
  assert.deepEqual(calls, ['2026-8', '2026-7']);
  assert.equal(store.data.usageDaily['deepseek:2026-07-15'].total, 50);
  assert.ok(!store.data.usageDaily['deepseek:2026-07-01'], '窗口外的日数据不应持久化');
  assert.ok(!store.data['providers.deepseek.syncedMonths'].includes('2026-06'), '窗口外月份不得标记');
  assert.equal(r.earliestDate, '2026-07-15');
});

// 未设置保留天数时保持原行为(无窗口过滤,向前探测到 36 月上限/连续空月)
test('未设置 data.historyDays 时不做窗口过滤', async () => {
  const store = makeStore({});
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (year === 2026 && month === 8) return [{ date: '2026-08-01', total: 10, cacheHit: 0, models: [] }];
    return [];
  };
  await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  // 2026-07 起连续 12 个空月(2026-07..2025-08)后停止
  assert.deepEqual(calls, ['2026-8', '2026-7', ...TWELVE_EMPTY_CALLS.slice(0, 11)]);
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
