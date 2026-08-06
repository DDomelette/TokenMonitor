const test = require('node:test');
const assert = require('node:assert/strict');
const { syncDeepSeekHistory, rescanLocalLogs } = require('../src/main/core/history-sync');

function makeStore(seed) {
  const data = Object.assign({}, seed);
  return { data, get(k) { return data[k]; }, set(k, v) { data[k] = v; } };
}
const noopSleep = async () => {};

test('逐月向前直到连续 2 个空月停止,同名键以 API 覆盖', async () => {
  const store = makeStore({ usageDaily: { 'deepseek:2026-08-01': { input: 0, cached: 0, output: 0, total: 1 } } });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (month === 8) return [{ date: '2026-08-01', total: 100, cacheHit: 40, models: [{ model: 'm1', tokens: 100 }] }];
    if (month === 7) return [{ date: '2026-07-15', total: 50, cacheHit: 0, models: [] }];
    return [];
  };
  const r = await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.deepEqual(calls, ['2026-8', '2026-7', '2026-6', '2026-5']);
  assert.equal(store.data.usageDaily['deepseek:2026-08-01'].total, 100);
  assert.equal(store.data.usageDaily['deepseek:2026-08-01'].cached, 40);
  assert.deepEqual(store.data.usageDaily['deepseek:2026-08-01'].models, [{ model: 'm1', tokens: 100 }]);
  assert.equal(store.data.usageDaily['deepseek:2026-07-15'].total, 50);
  assert.equal(r.monthsFetched, 4);
  assert.deepEqual(r.monthsFailed, []);
  assert.equal(r.earliestDate, '2026-07-15');
  assert.deepEqual(store.data['providers.deepseek.fetchedMonths'], ['2026-08', '2026-07', '2026-06', '2026-05']);
});

test('单月失败重试一次后跳过并计入 failed,流程不中断', async () => {
  const store = makeStore({});
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (month === 7) throw new Error('network');
    if (month === 8) return [{ date: '2026-08-01', total: 10, cacheHit: 0, models: [] }];
    return [];
  };
  const r = await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.deepEqual(calls, ['2026-8', '2026-7', '2026-7', '2026-6', '2026-5']);
  assert.deepEqual(r.monthsFailed, ['2026-07']);
  assert.equal(r.monthsFetched, 3);
  assert.ok(!store.data['providers.deepseek.fetchedMonths'].includes('2026-07'));
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

test('已在 fetchedMonths 中的月份直接跳过不重复请求', async () => {
  const store = makeStore({ 'providers.deepseek.fetchedMonths': ['2026-08', '2026-07'] });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (month === 6) return [{ date: '2026-06-17', total: 5, cacheHit: 0, models: [] }];
    return [];
  };
  const r = await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.deepEqual(calls, ['2026-6', '2026-5', '2026-4']);
  assert.equal(r.earliestDate, '2026-06-17');
});
