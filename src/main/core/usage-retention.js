const DAILY_KEY_PATTERN = /^([^:]+):(\d{4}-\d{2}-\d{2})$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeHistoryDays(value) {
  const days = Number(value);
  return Number.isInteger(days) && days > 0 ? days : null;
}

function localDayString(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function isValidLocalDay(day) {
  if (typeof day !== 'string' || !DAY_PATTERN.test(day)) return false;

  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const probe = new Date(0);
  probe.setHours(12, 0, 0, 0);
  probe.setFullYear(year, month - 1, date);

  return probe.getFullYear() === year
    && probe.getMonth() === month - 1
    && probe.getDate() === date;
}

function retentionStartDay(historyDays, nowMs) {
  const days = normalizeHistoryDays(historyDays);
  if (!days) return null;

  const date = new Date(nowMs === undefined ? Date.now() : nowMs);
  if (!Number.isFinite(date.getTime())) return null;
  // Midday avoids DST transitions around local midnight while moving by
  // calendar date rather than by a fixed number of milliseconds.
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - (days - 1));
  return localDayString(date.getTime());
}

function isRetainedDay(day, historyDays, nowMs) {
  if (!isValidLocalDay(day)) return false;
  const days = normalizeHistoryDays(historyDays);
  if (!days) return true;

  const now = nowMs === undefined ? Date.now() : nowMs;
  const start = retentionStartDay(days, now);
  const today = localDayString(now);
  return !!start && !!today && day >= start && day <= today;
}

function filterUsageDaily(usageDaily, historyDays, nowMs) {
  const source = usageDaily && typeof usageDaily === 'object' ? usageDaily : {};
  const days = normalizeHistoryDays(historyDays);
  const filtered = {};
  Object.keys(source).forEach((key) => {
    const match = DAILY_KEY_PATTERN.exec(key);
    if (!match) return;
    if (!isRetainedDay(match[2], days, nowMs)) return;
    filtered[key] = source[key];
  });
  return filtered;
}

function pruneUsageDaily(store, nowMs) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('pruneUsageDaily requires a store with get/set methods');
  }

  const historyDays = normalizeHistoryDays(store.get('data.historyDays'));
  if (!historyDays) return 0;

  const current = store.get('usageDaily') || {};
  const filtered = filterUsageDaily(current, historyDays, nowMs);
  const removed = Math.max(0, Object.keys(current).length - Object.keys(filtered).length);
  if (removed > 0) store.set('usageDaily', filtered);
  return removed;
}

module.exports = {
  filterUsageDaily,
  isRetainedDay,
  localDayString,
  normalizeHistoryDays,
  pruneUsageDaily,
  retentionStartDay
};
