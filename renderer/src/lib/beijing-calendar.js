// 浏览器/Node 共用日历实现,保留既有 ESM 导出。
import '../../../src/shared/beijing-calendar.js';

const {
  beijingDateParts,
  beijingDayKey,
  isValidBeijingDayKey,
  addBeijingDays,
  millisecondsUntilNextBeijingMidnight,
  isAfterBeijingToday,
  beijingMonthDayLabel,
  localDateKey,
  localDayKey
} = globalThis.TokenMonitorCalendar;

export {
  beijingDateParts,
  beijingDayKey,
  isValidBeijingDayKey,
  addBeijingDays,
  millisecondsUntilNextBeijingMidnight,
  isAfterBeijingToday,
  beijingMonthDayLabel,
  localDateKey,
  localDayKey
};
