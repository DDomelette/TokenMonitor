const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const clockPath = path.join(root, 'renderer', 'src', 'lib', 'local-calendar-clock.js');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

// 北京墙钟 -> 绝对时刻:任意主机时区下都指向同一个瞬间,测试因此与进程时区无关
function bj(y, m, d, h = 0, min = 0, s = 0, ms = 0) {
  return new Date(Date.UTC(y, m - 1, d, h, min, s, ms) - 8 * 60 * 60 * 1000);
}

async function loadClockModule() {
  assert.equal(fs.existsSync(clockPath), true, 'local calendar clock module must exist');
  // 模块依赖 ./beijing-calendar.js,须以真实文件 URL 加载才能解析相对导入
  const url = pathToFileURL(clockPath).href + '?v=' + Date.now() + Math.random();
  return import(url);
}

test('next Beijing midnight delay crosses day and year boundaries exactly', async () => {
  const { millisecondsUntilNextLocalMidnight } = await loadClockModule();

  assert.equal(
    millisecondsUntilNextLocalMidnight(bj(2026, 8, 8, 23, 59, 50, 0)),
    10_000
  );
  assert.equal(
    millisecondsUntilNextLocalMidnight(bj(2026, 12, 31, 23, 59, 59, 250)),
    750
  );
});

test('clock emits once when a Beijing Saturday crosses into Sunday and reschedules', async () => {
  const { createLocalCalendarClock, localDayKey } = await loadClockModule();
  let current = bj(2026, 8, 8, 23, 59, 50, 0); // Beijing Saturday
  let scheduled = null;
  let nextId = 0;
  const changes = [];

  const clock = createLocalCalendarClock({
    now: () => new Date(current.getTime()),
    setTimer(callback, delay) {
      scheduled = { callback, delay, id: ++nextId };
      return nextId;
    },
    clearTimer() {},
    onChange(date, key) {
      changes.push({ key });
    }
  });

  assert.equal(clock.dayKey, localDayKey(current));
  assert.equal(scheduled.delay, 10_000);

  current = bj(2026, 8, 9, 0, 0, 0, 0); // Beijing Sunday
  scheduled.callback();
  assert.deepEqual(changes, [{ key: '2026-08-09' }]);
  assert.equal(scheduled.delay, 86_400_000);

  // A spurious same-day callback must not cause another render, but must keep the clock alive.
  const firstRescheduleId = scheduled.id;
  scheduled.callback();
  assert.equal(changes.length, 1);
  assert.ok(scheduled.id > firstRescheduleId);

  clock.stop();
});

test('clock catches up after sleep, follows a new Beijing year, and clears its timer on stop', async () => {
  const { createLocalCalendarClock, resolveHeatmapYear } = await loadClockModule();
  let current = bj(2026, 12, 31, 23, 59, 30, 0); // Beijing 2026-12-31 23:59:30
  let scheduled = null;
  const cleared = [];
  const dates = [];
  let id = 0;

  const clock = createLocalCalendarClock({
    now: () => new Date(current.getTime()),
    setTimer(callback, delay) {
      scheduled = { callback, delay, id: ++id };
      return id;
    },
    clearTimer(timerId) { cleared.push(timerId); },
    onChange(date) { dates.push(date); }
  });

  // Simulate the process waking two days late instead of exactly at the scheduled midnight.
  current = bj(2027, 1, 2, 8, 15, 0, 0); // Beijing 2027-01-02 08:15
  scheduled.callback();
  assert.equal(dates.length, 1);
  assert.equal(resolveHeatmapYear(undefined, dates[0]), 2027);
  assert.equal(resolveHeatmapYear(2024, dates[0]), 2024, 'an explicit historical year remains fixed');

  const activeTimer = scheduled.id;
  clock.stop();
  assert.deepEqual(cleared, [activeTimer]);
  scheduled.callback();
  assert.equal(dates.length, 1, 'a stopped clock ignores late timer callbacks');
});

test('resolveHeatmapYear derives the Beijing year from 2026-12-31T16:00:00.000Z as 2027', async () => {
  const { resolveHeatmapYear } = await loadClockModule();
  const instant = new Date('2026-12-31T16:00:00.000Z');
  assert.equal(resolveHeatmapYear(undefined, instant), 2027);
  assert.equal(resolveHeatmapYear(2026, instant), 2026, 'an explicit year is never overridden');
});

test('current-day column follows the supplied local day key and falls back to the final column', async () => {
  const { findDayColumn } = await loadClockModule();
  const weeks = [
    [{ date: '2026-08-02' }, { date: '2026-08-03' }],
    [{ date: '2026-08-09' }, { date: '2026-08-10' }],
    [{ date: '2026-08-16' }, { date: '2026-08-17' }]
  ];

  assert.equal(findDayColumn(weeks, '2026-08-08'), 2, 'unknown days use the current final-column behavior');
  assert.equal(findDayColumn(weeks, '2026-08-09'), 1, 'Sunday enters the new visual column');
  assert.equal(findDayColumn(weeks, '2026-08-17'), 2);
  assert.equal(findDayColumn([], '2026-08-17'), -1);
});

test('TokenHeatmap derives its live year and today column from the calendar clock', () => {
  const source = read('renderer/src/components/TokenHeatmap.jsx');

  assert.match(source, /local-calendar-clock\.js/);
  assert.match(source, /year:\s*requestedYear/);
  assert.match(source, /useState\(\(\)\s*=>\s*new Date\(\)\)/);
  assert.match(source, /createLocalCalendarClock\(\{/);
  assert.match(source, /onChange:[\s\S]*setClockDate/);
  assert.match(source, /return \(\) => clock\.stop\(\)/);
  assert.match(source, /resolveHeatmapYear\(requestedYear, clockDate\)/);
  assert.match(source, /localDayKey\(clockDate\)/);
  assert.match(source, /findDayColumn\(weeks, todayKey\)/);
  assert.match(source, /\[weeks, todayKey\]/);
  assert.doesNotMatch(source, /const todayCol = useMemo\(\(\) => \{\s*const now = new Date\(\)/);
});
