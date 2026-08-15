const {
  beijingDayKey,
  addBeijingDays,
  isValidBeijingDayKey,
  localDayStr
} = require('./beijing-calendar');

const DAILY_KEY_PATTERN = /^([^:]+):(\d{4}-\d{2}-\d{2})$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeHistoryDays(value) {
  const days = Number(value);
  return Number.isInteger(days) && days > 0 ? days : null;
}

function localDayString(timestamp) {
  return localDayStr(timestamp);
}

function isValidLocalDay(day) {
  return typeof day === 'string'
    && DAY_PATTERN.test(day)
    && isValidBeijingDayKey(day);
}

function retentionStartDay(historyDays, nowMs) {
  const days = normalizeHistoryDays(historyDays);
  if (!days) return null;

  const today = beijingDayKey(nowMs === undefined ? Date.now() : nowMs);
  if (!today) return null;
  // 以北京结算日为基准按日历日回退,不经过任何操作系统时区/DST 计算。
  return addBeijingDays(today, -(days - 1));
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
  const currentCost = store.get('usageDailyCost') || {};
  const filteredCost = filterUsageDaily(currentCost, historyDays, nowMs);
  const removedCost = Math.max(0, Object.keys(currentCost).length - Object.keys(filteredCost).length);
  if (removed > 0) store.set('usageDaily', filtered);
  if (removedCost > 0) store.set('usageDailyCost', filteredCost);
  return removed;
}

const PUSH_USAGE_KEY = 'usageDailyPush';
const PUSH_COST_KEY = 'usageDailyCostPush';

function pruneDshPushUsage(store, nowMs) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('pruneDshPushUsage requires a store with get/set methods');
  }

  const historyDays = normalizeHistoryDays(store.get('data.historyDays'));
  if (!historyDays) return 0;

  let removed = 0;
  [PUSH_USAGE_KEY, PUSH_COST_KEY].forEach((key) => {
    const current = store.get(key) || {};
    const filtered = filterUsageDaily(current, historyDays, nowMs);
    const n = Math.max(0, Object.keys(current).length - Object.keys(filtered).length);
    if (n > 0) store.set(key, filtered);
    removed += n;
  });
  return removed;
}

module.exports = {
  filterUsageDaily,
  isRetainedDay,
  localDayString,
  normalizeHistoryDays,
  pruneUsageDaily,
  pruneDshPushUsage,
  retentionStartDay
};
