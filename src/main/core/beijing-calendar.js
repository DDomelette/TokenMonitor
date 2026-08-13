// 北京结算日历:UTC+8 固定偏移,不依赖操作系统时区或夏令时规则。
// 仅供主进程采集与保留逻辑使用;渲染端对应模块见 renderer/src/lib/beijing-calendar.js。
// 兼容包装保留既有导出名,语义固定为北京时间。

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const BEIJING_OFFSET_SECONDS = 8 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function beijingDateParts(value = Date.now()) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  const shifted = new Date(timestamp + BEIJING_OFFSET_MS);
  if (!Number.isFinite(shifted.getTime())) return null;
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function beijingDayKey(value = Date.now()) {
  const parts = beijingDateParts(value);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function isValidBeijingDayKey(day) {
  if (typeof day !== 'string') return false;
  const match = DAY_KEY_PATTERN.exec(day);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, date, 12));
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === date;
}

function addBeijingDays(dayKey, delta) {
  if (!isValidBeijingDayKey(dayKey) || !Number.isFinite(Number(delta))) return null;
  const year = Number(dayKey.slice(0, 4));
  const month = Number(dayKey.slice(5, 7));
  const date = Number(dayKey.slice(8, 10));
  const base = new Date(Date.UTC(year, month - 1, date, 12));
  base.setUTCDate(base.getUTCDate() + Number(delta));
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(base.getUTCDate()).padStart(2, '0')}`;
}

function inclusiveBeijingDayCount(startDayKey, value = Date.now()) {
  if (!isValidBeijingDayKey(startDayKey)) return 0;
  const endDayKey = beijingDayKey(value);
  if (!endDayKey) return 0;

  const ordinal = (dayKey) => {
    const year = Number(dayKey.slice(0, 4));
    const month = Number(dayKey.slice(5, 7));
    const date = Number(dayKey.slice(8, 10));
    return Math.floor(Date.UTC(year, month - 1, date) / DAY_MS);
  };
  return Math.max(0, ordinal(endDayKey) - ordinal(startDayKey) + 1);
}

function millisecondsUntilNextBeijingMidnight(value = Date.now()) {
  const timestamp = Number(value);
  const parts = beijingDateParts(timestamp);
  if (!parts) return null;
  const nextMidnightMs = Date.UTC(parts.year, parts.month - 1, parts.day + 1) - BEIJING_OFFSET_MS;
  return Math.max(1, nextMidnightMs - timestamp);
}

// 兼容包装:既有调用点按原名导入,语义固定为北京时间。
function localDayStr(tsMs) {
  return beijingDayKey(tsMs);
}

function localTodayStr() {
  return beijingDayKey();
}

function localDateKey(value) {
  return beijingDayKey(value);
}

function localDayKey(value) {
  return beijingDayKey(value);
}

function localTzSec() {
  return BEIJING_OFFSET_SECONDS;
}

module.exports = {
  BEIJING_OFFSET_MS,
  BEIJING_OFFSET_SECONDS,
  beijingDateParts,
  beijingDayKey,
  isValidBeijingDayKey,
  addBeijingDays,
  inclusiveBeijingDayCount,
  millisecondsUntilNextBeijingMidnight,
  localDayStr,
  localTodayStr,
  localDateKey,
  localDayKey,
  localTzSec
};
