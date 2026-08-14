const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

// 与 ChartWidget/buildCurvePoints 一致的点构造: UTC 午夜时间，date 为 YYYY-MM-DD。
const { mergeCurves } = require('../renderer/src/lib/curve-merge.js');

function point(dateStr, totalCost, deltaCost) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { time: Date.UTC(y, m - 1, d), totalCost, deltaCost };
}

// 浮点累加用容差比较(0.1+0.2 !== 0.3 是 IEEE-754 语义,不是合并逻辑错误)。
function assertClose(actual, expected, message) {
  assert.ok(
    actual.length === expected.length
      && actual.every((v, i) => Number.isFinite(v) && Math.abs(v - expected[i]) < 1e-9),
    message || `expected ${JSON.stringify(expected)} to be within 1e-9 of ${JSON.stringify(actual)}`
  );
}

test('mergeCurves returns [] for no or empty curves', () => {
  assert.deepEqual(mergeCurves([]), []);
  assert.deepEqual(mergeCurves(undefined), []);
  assert.deepEqual(mergeCurves([[], []]), []);
});

test('mergeCurves merges multiple curves by date, sums deltaCost and recomputes cumulative totalCost ascending', () => {
  const deepseek = [
    point('2026-08-12', 0.3, 0.3),
    point('2026-08-13', 0.5, 0.2),
    point('2026-08-14', 1.0, 0.5)
  ];
  const dsh = [
    point('2026-08-13', 0.1, 0.1),
    point('2026-08-14', 0.35, 0.25)
  ];
  const merged = mergeCurves([deepseek, dsh]);
  assertClose(merged.map((p) => p.deltaCost), [0.3, 0.3, 0.75]);
  assertClose(merged.map((p) => p.totalCost), [0.3, 0.6, 1.35]);
  const times = merged.map((p) => p.time);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('mergeCurves passes through a single curve and skips points without a finite time', () => {
  const single = [
    point('2026-08-12', 0.3, 0.3),
    { time: NaN },
    point('2026-08-13', 0.5, 0.2)
  ];
  const merged = mergeCurves([single]);
  assertClose(merged.map((p) => p.totalCost), [0.3, 0.5]);
  assertClose(merged.map((p) => p.deltaCost), [0.3, 0.2]);
});

test('mergeCurves collapses same-day points from one curve into a single point', () => {
  const a = [point('2026-08-12', 0.3, 0.3), point('2026-08-12', 0.2, 0.2)];
  const merged = mergeCurves([a]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], { time: point('2026-08-12', 0, 0).time, totalCost: 0.5, deltaCost: 0.5 });
});

test('mergeCurves keeps Beijing day keys stable on a UTC-minus host', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const merged = mergeCurves([[
      point('2026-08-14', 0.2, 0.2),
      point('2026-08-15', 0.5, 0.3)
    ]]);
    assert.deepEqual(merged.map((p) => p.time), [
      Date.UTC(2026, 7, 14),
      Date.UTC(2026, 7, 15)
    ]);
    assertClose(merged.map((p) => p.totalCost), [0.2, 0.5]);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

// Production mutation caught: replacing the Beijing-aware pure label path with
// host-local Date getters shifts UTC-midnight merged points back one day in LA.
test('ChartWidget curve labels keep merged UTC-midnight days on a Los Angeles host', () => {
  const curveModuleUrl = pathToFileURL(
    path.resolve(__dirname, '../renderer/src/lib/curve-merge.js')
  ).href;
  const source = `
    (async () => {
      const { mergeCurves, curvePointLabels } = await import(${JSON.stringify(curveModuleUrl)});
      const merged = mergeCurves([[
        { time: Date.UTC(2026, 7, 14), totalCost: 1, deltaCost: 1 },
        { time: Date.UTC(2026, 7, 15), totalCost: 2, deltaCost: 1 }
      ]]);
      console.log(JSON.stringify(curvePointLabels(merged)));
    })().catch((error) => {
      console.error(error && error.stack ? error.stack : error);
      process.exitCode = 1;
    });
  `;
  const result = spawnSync(process.execPath, ['--eval', source], {
    env: Object.assign({}, process.env, { TZ: 'America/Los_Angeles' }),
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['8/14', '8/15']);
});
