import {
  beijingDateParts,
  beijingDayKey,
  millisecondsUntilNextBeijingMidnight
} from './beijing-calendar.js';

export function localDayKey(date) {
  return beijingDayKey(date);
}

export function millisecondsUntilNextLocalMidnight(date) {
  return millisecondsUntilNextBeijingMidnight(date);
}

export function resolveHeatmapYear(requestedYear, date) {
  if (Number.isFinite(requestedYear)) return requestedYear;
  const parts = beijingDateParts(date);
  return parts ? parts.year : date.getFullYear();
}

export function findDayColumn(weeks, dayKey) {
  if (!Array.isArray(weeks) || weeks.length === 0) return -1;
  for (let column = 0; column < weeks.length; column += 1) {
    if (weeks[column].some((cell) => cell && cell.date === dayKey)) return column;
  }
  return weeks.length - 1;
}

export function createLocalCalendarClock(options = {}) {
  const now = options.now || (() => new Date());
  const setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer || ((timer) => clearTimeout(timer));
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

  let stopped = false;
  let timer = null;
  let dayKey = localDayKey(now());

  function schedule() {
    if (stopped) return;
    const current = now();
    timer = setTimer(tick, millisecondsUntilNextLocalMidnight(current));
  }

  function tick() {
    if (stopped) return;
    const current = now();
    const nextKey = localDayKey(current);
    if (nextKey !== dayKey) {
      dayKey = nextKey;
      onChange(current, nextKey);
    }
    schedule();
  }

  schedule();

  return {
    get dayKey() {
      return dayKey;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    }
  };
}
