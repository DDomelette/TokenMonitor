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

test('a winter scan groups a summer New York midnight record by the summer date', () => {
  assert.deepEqual(
    evaluate(
      'America/New_York',
      '2026-01-15T17:00:00.000Z',
      '2026-07-15T04:30:00.000Z'
    ),
    {
      day: '2026-07-15',
      offsetSeconds: -4 * 60 * 60,
      rollupKeys: ['fixture:2026-07-15']
    }
  );
});

test('a summer scan groups a winter New York late-night record by the winter date', () => {
  assert.deepEqual(
    evaluate(
      'America/New_York',
      '2026-07-15T16:00:00.000Z',
      '2026-01-15T04:30:00.000Z'
    ),
    {
      day: '2026-01-14',
      offsetSeconds: -5 * 60 * 60,
      rollupKeys: ['fixture:2026-01-14']
    }
  );
});

test('New York spring-forward records use the offset at each record timestamp', () => {
  const before = evaluate(
    'America/New_York',
    '2026-01-15T17:00:00.000Z',
    '2026-03-08T06:30:00.000Z'
  );
  const after = evaluate(
    'America/New_York',
    '2026-01-15T17:00:00.000Z',
    '2026-03-08T07:30:00.000Z'
  );

  assert.equal(before.day, '2026-03-08');
  assert.equal(before.offsetSeconds, -5 * 60 * 60);
  assert.equal(after.day, '2026-03-08');
  assert.equal(after.offsetSeconds, -4 * 60 * 60);
});

test('New York fall-back records use the offset at each record timestamp', () => {
  const before = evaluate(
    'America/New_York',
    '2026-07-15T16:00:00.000Z',
    '2026-11-01T05:30:00.000Z'
  );
  const after = evaluate(
    'America/New_York',
    '2026-07-15T16:00:00.000Z',
    '2026-11-01T06:30:00.000Z'
  );

  assert.equal(before.day, '2026-11-01');
  assert.equal(before.offsetSeconds, -4 * 60 * 60);
  assert.equal(after.day, '2026-11-01');
  assert.equal(after.offsetSeconds, -5 * 60 * 60);
});

test('a non-DST timezone keeps the existing local calendar behavior', () => {
  assert.deepEqual(
    evaluate(
      'Asia/Singapore',
      '2026-01-15T12:00:00.000Z',
      '2026-07-15T16:30:00.000Z'
    ),
    {
      day: '2026-07-16',
      offsetSeconds: 8 * 60 * 60,
      rollupKeys: ['fixture:2026-07-16']
    }
  );
});
