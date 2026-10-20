import { beijingDayKey, addBeijingDays } from './lib/beijing-calendar.js';

export function localDateKey(value = Date.now()) {
  return beijingDayKey(value);
}

export function previousLocalDateKey(value = Date.now()) {
  const today = beijingDayKey(value);
  if (!today) return null;
  return addBeijingDays(today, -1);
}

export function getYesterdayCost(costDaily, value = Date.now()) {
  if (!Array.isArray(costDaily) || costDaily.length === 0) return 0;
  const yesterdayKey = previousLocalDateKey(value);
  if (!yesterdayKey) return 0;

  for (let index = costDaily.length - 1; index >= 0; index -= 1) {
    const row = costDaily[index];
    if (!row || row.date !== yesterdayKey) continue;
    const total = Number(row.total);
    return Number.isFinite(total) ? total : 0;
  }

  return 0;
}

// 近 30 天花费:北京日期 [今天-29, 今天] 闭区间内每日费用求和。
// 数据由主进程按当月+上月拼接(见 deepseek 适配器 prependPreviousMonthCost),跨月不缺尾。
export function getLast30DaysCost(costDaily, value = Date.now()) {
  if (!Array.isArray(costDaily) || costDaily.length === 0) return 0;
  const todayKey = beijingDayKey(value);
  if (!todayKey) return 0;
  const startKey = addBeijingDays(todayKey, -29);
  if (!startKey) return 0;

  let sum = 0;
  costDaily.forEach((row) => {
    if (!row || typeof row.date !== 'string') return;
    if (row.date < startKey || row.date > todayKey) return;
    const total = Number(row.total);
    if (Number.isFinite(total)) sum += total;
  });
  return sum;
}
