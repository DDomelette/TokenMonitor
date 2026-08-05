export function localDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function millisecondsUntilNextLocalMidnight(date) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return Math.max(1, next.getTime() - date.getTime());
}

export function resolveHeatmapYear(requestedYear, date) {
  return Number.isFinite(requestedYear) ? requestedYear : date.getFullYear();
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
