// 北京结算日历(渲染端):依赖自由的 ES 模块,与主进程 src/main/core/beijing-calendar.js 同构。
// 图表、费用卡片、热力图时钟统一按北京时间结算日归属;兼容包装保留既有导出名。

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function beijingDateParts(value = Date.now()) {
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

export function beijingDayKey(value = Date.now()) {
  const parts = beijingDateParts(value);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function isValidBeijingDayKey(day) {
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

export function addBeijingDays(dayKey, delta) {
  if (!isValidBeijingDayKey(dayKey) || !Number.isFinite(Number(delta))) return null;
  const year = Number(dayKey.slice(0, 4));
  const month = Number(dayKey.slice(5, 7));
  const date = Number(dayKey.slice(8, 10));
  const base = new Date(Date.UTC(year, month - 1, date, 12));
  base.setUTCDate(base.getUTCDate() + Number(delta));
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(base.getUTCDate()).padStart(2, '0')}`;
}

export function millisecondsUntilNextBeijingMidnight(value = Date.now()) {
  const timestamp = Number(value);
  const parts = beijingDateParts(timestamp);
  if (!parts) return null;
  const nextMidnightMs = Date.UTC(parts.year, parts.month - 1, parts.day + 1) - BEIJING_OFFSET_MS;
  return Math.max(1, nextMidnightMs - timestamp);
}

// 兼容包装:既有调用点按原名导入,语义固定为北京时间。接受 Date 或时间戳。
export function localDateKey(value = Date.now()) {
  return beijingDayKey(value);
}

export function localDayKey(value) {
  return beijingDayKey(value);
}
