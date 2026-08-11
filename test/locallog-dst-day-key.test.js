const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const modulePath = path.resolve(__dirname, '../src/main/core/locallog.js');

function evaluate(timeZone, scanNowIso, targetIso) {
  const source = `
    const { localDayStr, localTzSec, rollupDaily } = require(${JSON.stringify(modulePath)});
    const RealDate = Date;
    const scanNow = RealDate.parse(${JSON.stringify(scanNowIso)});
    global.Date = class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [scanNow]));
      }
      static now() { return scanNow; }
    };
    const target = RealDate.parse(${JSON.stringify(targetIso)});
    const rollup = rollupDaily([
      { provider: 'fixture', ts: target, usage: { total: 1 } }
    ], null, RealDate.parse('2026-12-31T12:00:00.000Z'));
    console.log(JSON.stringify({
      day: localDayStr(target),
      offsetSeconds: localTzSec(target),
      rollupKeys: Object.keys(rollup)
    }));
  `;
  const result = spawnSync(process.execPath, ['--eval', source], {
    env: Object.assign({}, process.env, { TZ: timeZone }),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('a summer record groups by the Beijing settlement day in every host timezone', () => {
  for (const zone of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
    assert.deepEqual(
      evaluate(zone, '2026-01-15T17:00:00.000Z', '2026-07-15T04:30:00.000Z'),
      {
        day: '2026-07-15',
        offsetSeconds: 8 * 60 * 60,
        rollupKeys: ['fixture:2026-07-15']
      }
    );
  }
});

test('a winter late-night record groups by the Beijing settlement day in every host timezone', () => {
  for (const zone of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
    assert.deepEqual(
      evaluate(zone, '2026-07-15T16:00:00.000Z', '2026-01-15T04:30:00.000Z'),
      {
        day: '2026-01-15',
        offsetSeconds: 8 * 60 * 60,
        rollupKeys: ['fixture:2026-01-15']
      }
    );
  }
});

test('the Beijing day boundary is fixed at 16:00 UTC regardless of host timezone or DST', () => {
  for (const zone of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
    assert.deepEqual(
      evaluate(zone, '2026-07-15T16:00:00.000Z', '2026-07-15T15:59:59.999Z'),
      {
        day: '2026-07-15',
        offsetSeconds: 8 * 60 * 60,
        rollupKeys: ['fixture:2026-07-15']
      }
    );
    assert.deepEqual(
      evaluate(zone, '2026-07-15T16:00:00.000Z', '2026-07-15T16:00:00.000Z'),
      {
        day: '2026-07-16',
        offsetSeconds: 8 * 60 * 60,
        rollupKeys: ['fixture:2026-07-16']
      }
    );
  }
});

test('a DST-observed host timezone keeps the same Beijing settlement day as UTC', () => {
  const newYork = evaluate(
    'America/New_York',
    '2026-01-15T17:00:00.000Z',
    '2026-03-08T16:30:00.000Z'
  );
  const utc = evaluate(
    'UTC',
    '2026-01-15T17:00:00.000Z',
    '2026-03-08T16:30:00.000Z'
  );
  assert.deepEqual(newYork, utc);
  assert.equal(utc.day, '2026-03-09');
});
