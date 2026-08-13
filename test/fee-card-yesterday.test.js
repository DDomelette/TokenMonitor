const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const helperUrl = pathToFileURL(
  path.resolve(__dirname, '../renderer/src/fee-card-date.mjs')
).href;

function evaluateInTimezone(timeZone, nowIso, dailyData) {
  const source = `
    import { localDateKey, previousLocalDateKey, getYesterdayCost } from ${JSON.stringify(helperUrl)};
    const now = Date.parse(${JSON.stringify(nowIso)});
    const daily = ${JSON.stringify(dailyData)};
    console.log(JSON.stringify({
      today: localDateKey(now),
      yesterday: previousLocalDateKey(now),
      cost: getYesterdayCost(daily, now)
    }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: Object.assign({}, process.env, { TZ: timeZone }),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('UTC+8 local midnight uses the Beijing previous calendar date', () => {
  const result = evaluateInTimezone(
    'Asia/Shanghai',
    '2026-08-04T16:30:00.000Z',
    [
      { date: '2026-08-03', total: 3 },
      { date: '2026-08-04', total: 4 }
    ]
  );

  assert.deepEqual(result, {
    today: '2026-08-05',
    yesterday: '2026-08-04',
    cost: 4
  });
});

test('a UTC- timezone still resolves yesterday from the Beijing date, not the host calendar', () => {
  const result = evaluateInTimezone(
    'America/Los_Angeles',
    '2026-01-01T07:30:00.000Z',
    [
      { date: '2025-12-29', total: 29 },
      { date: '2025-12-30', total: 30 },
      { date: '2025-12-31', total: 31 }
    ]
  );

  assert.deepEqual(result, {
    today: '2026-01-01',
    yesterday: '2025-12-31',
    cost: 31
  });
});

test('the same instant derives the same Beijing yesterday in every host timezone', () => {
  for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    const result = evaluateInTimezone(
      zone,
      '2025-12-31T10:30:00.000Z',
      [
        { date: '2025-12-30', total: 30 },
        { date: '2025-12-31', total: 31 }
      ]
    );

    assert.deepEqual(result, {
      today: '2025-12-31',
      yesterday: '2025-12-30',
      cost: 30
    });
  }
});

test('today may be absent, but only the exact yesterday row is eligible', () => {
  const withYesterday = evaluateInTimezone(
    'Asia/Singapore',
    '2026-08-05T12:00:00.000Z',
    [
      { date: '2026-08-02', total: 2 },
      { date: '2026-08-04', total: 4 }
    ]
  );
  assert.equal(withYesterday.cost, 4);

  const withoutYesterday = evaluateInTimezone(
    'Asia/Singapore',
    '2026-08-05T12:00:00.000Z',
    [
      { date: '2026-08-02', total: 2 },
      { date: '2026-08-03', total: 3 }
    ]
  );
  assert.equal(withoutYesterday.cost, 0);
});

test('FeeCard delegates yesterday lookup and no longer derives a UTC date inline', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/components/FeeCard.jsx'),
    'utf8'
  );

  assert.match(source, /import \{ getYesterdayCost \} from '\.\.\/fee-card-date\.mjs';/);
  assert.doesNotMatch(source, /toISOString\(\)/);
  assert.doesNotMatch(source, /function getYesterdayCost\s*\(/);
});
