function pad2(value) {
  return String(value).padStart(2, '0');
}

export function localDateKey(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function previousLocalDateKey(value = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const previous = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - 1,
    12,
    0,
    0,
    0
  );
  return localDateKey(previous);
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
