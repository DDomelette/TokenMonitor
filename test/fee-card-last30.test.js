const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const helperUrl = pathToFileURL(
  path.resolve(__dirname, '../renderer/src/fee-card-date.mjs')
).href;

function sumInTimezone(timeZone, nowIso, dailyData) {
  const source = `
    import { getLast30DaysCost } from ${JSON.stringify(helperUrl)};
    const now = Date.parse(${JSON.stringify(nowIso)});
    const daily = ${JSON.stringify(dailyData)};
    console.log(JSON.stringify({ sum: getLast30DaysCost(daily, now) }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: Object.assign({}, process.env, { TZ: timeZone }),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim()).sum;
}

test('sums exactly the Beijing last-30-day window, inclusive of today', () => {
  const sum = sumInTimezone(
    'Asia/Shanghai',
    '2026-08-30T04:00:00.000Z', // 北京 2026-08-30 12:00
    [
      { date: '2026-07-31', total: 100 }, // 窗口外(第 31 天前)
      { date: '2026-08-01', total: 1 },   // 窗口起点(今天-29)
      { date: '2026-08-15', total: 2 },
      { date: '2026-08-30', total: 4 },   // 今天
      { date: '2026-08-31', total: 8 }    // 未来日(零填充),不计入
    ]
  );

  assert.equal(sum, 7);
});

test('the same instant derives the same Beijing 30-day window in every host timezone', () => {
  const daily = [
    { date: '2025-12-31', total: 31 },
    { date: '2026-01-01', total: 1 }
  ];
  for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    // 北京 2026-01-01 08:30:窗口为 2025-12-03 ~ 2026-01-01,两天都在窗口内
    const sum = sumInTimezone(zone, '2026-01-01T00:30:00.000Z', daily);
    assert.equal(sum, 32, zone);
  }
});

test('non-numeric and out-of-window rows are ignored; empty input yields 0', () => {
  const sum = sumInTimezone(
    'Asia/Shanghai',
    '2026-08-30T04:00:00.000Z',
    [
      { date: '2026-08-10', total: 'abc' },
      { date: '2020-01-01', total: 999 },
      { date: '2026-08-10', total: 5 },
      null
    ]
  );
  assert.equal(sum, 5);

  assert.equal(sumInTimezone('Asia/Shanghai', '2026-08-30T04:00:00.000Z', []), 0);
});
