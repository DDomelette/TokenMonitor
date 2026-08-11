// 北京结算日历(UTC+8 固定偏移)时区不变性测试。
// 同一时刻在任意主机时区下都必须归属同一个北京结算日。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const modulePath = path.resolve(__dirname, '../src/main/core/beijing-calendar.js');
const retentionPath = path.resolve(__dirname, '../src/main/core/usage-retention.js');
const rendererCalendarUrl = pathToFileURL(
  path.resolve(__dirname, '../renderer/src/lib/beijing-calendar.js')
).href;

function evaluate(timeZone, targetIso) {
  const source = `
    const cal = require(${JSON.stringify(modulePath)});
    const target = Date.parse(${JSON.stringify(targetIso)});
    const parts = cal.beijingDateParts(target);
    console.log(JSON.stringify({
      dayKey: cal.beijingDayKey(target),
      year: parts.year,
      month: parts.month,
      day: parts.day
    }));
  `;
  const result = spawnSync(process.execPath, ['--eval', source], {
    env: Object.assign({}, process.env, { TZ: timeZone }),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function retainedKeysInTimezone(timeZone, dayKey) {
  const source = `
    const { filterUsageDaily } = require(${JSON.stringify(retentionPath)});
    const key = 'codex:' + ${JSON.stringify(dayKey)};
    console.log(JSON.stringify(Object.keys(filterUsageDaily({ [key]: { total: 1 } }))));
  `;
  const result = spawnSync(process.execPath, ['--eval', source], {
    env: Object.assign({}, process.env, { TZ: timeZone }),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('the same instant always belongs to the Beijing settlement day', () => {
  for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    assert.deepEqual(evaluate(zone, '2026-08-10T16:30:00.000Z'), {
      dayKey: '2026-08-11',
      year: 2026,
      month: 8,
      day: 11
    });
  }
});

test('Beijing calendar addition crosses month and year boundaries', () => {
  const cal = require(modulePath);
  assert.equal(cal.addBeijingDays('2026-01-01', -1), '2025-12-31');
  assert.equal(cal.addBeijingDays('2024-02-28', 1), '2024-02-29');
  assert.equal(cal.addBeijingDays('2024-02-29', 1), '2024-03-01');
  assert.equal(cal.addBeijingDays('2026-12-31', 1), '2027-01-01');
});

test('Beijing settlement day flips exactly at 16:00 UTC', () => {
  const cal = require(modulePath);
  assert.equal(cal.beijingDayKey(Date.parse('2026-08-10T15:59:59.999Z')), '2026-08-10');
  assert.equal(cal.beijingDayKey(Date.parse('2026-08-10T16:00:00.000Z')), '2026-08-11');
});

test('millisecondsUntilNextBeijingMidnight targets the next 16:00 UTC boundary', () => {
  const cal = require(modulePath);
  assert.equal(
    cal.millisecondsUntilNextBeijingMidnight(Date.parse('2026-08-10T15:59:59.000Z')),
    1000
  );
  assert.equal(
    cal.millisecondsUntilNextBeijingMidnight(Date.parse('2026-08-10T14:00:00.000Z')),
    2 * 60 * 60 * 1000
  );
});

test('2026-12-31T16:00:00.000Z resolves to Beijing year 2027', () => {
  const cal = require(modulePath);
  assert.deepEqual(cal.beijingDateParts(Date.parse('2026-12-31T16:00:00.000Z')), {
    year: 2027,
    month: 1,
    day: 1
  });
  assert.equal(cal.beijingDayKey(Date.parse('2026-12-31T16:00:00.000Z')), '2027-01-01');
});

test('Beijing-valid dates remain valid in host zones that skipped that local date', () => {
  assert.deepEqual(retainedKeysInTimezone('Pacific/Apia', '2011-12-30'), [
    'codex:2011-12-30'
  ]);
});

test('renderer daily charts compare rows against Beijing today', async () => {
  const calendar = await import(rendererCalendarUrl + '?review=' + Date.now());
  const atBeijing0030 = Date.parse('2026-08-10T16:30:00.000Z');
  assert.equal(calendar.isAfterBeijingToday('2026-08-11', atBeijing0030), false);
  assert.equal(calendar.isAfterBeijingToday('2026-08-12', atBeijing0030), true);
});

test('renderer curve labels use Beijing month and day', async () => {
  const calendar = await import(rendererCalendarUrl + '?label=' + Date.now());
  assert.equal(
    calendar.beijingMonthDayLabel(Date.parse('2026-08-10T16:00:00.000Z')),
    '8/11'
  );
});

test('inclusive Beijing day counts ignore host timezone and cross-year offsets', () => {
  const cal = require(modulePath);
  assert.equal(
    cal.inclusiveBeijingDayCount('2025-12-31', Date.parse('2026-01-01T16:30:00.000Z')),
    3
  );
  assert.equal(
    cal.inclusiveBeijingDayCount('2026-01-03', Date.parse('2026-01-01T16:30:00.000Z')),
    0
  );
});
