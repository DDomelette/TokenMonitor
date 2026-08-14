const test = require('node:test');
const assert = require('node:assert/strict');

// 与 ChartWidget/buildCurvePoints 一致的点构造:本地午夜时间,date 为 YYYY-MM-DD。
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
