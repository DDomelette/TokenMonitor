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
