const test = require('node:test');
const assert = require('node:assert/strict');

function stubWindow(t, innerWidth, innerHeight) {
  const prev = globalThis.window;
  globalThis.window = { innerWidth, innerHeight };
  t.after(() => {
    if (prev === undefined) delete globalThis.window;
    else globalThis.window = prev;
  });
}

const {
  clampToWindow,
  resolveVerticalFlip,
  echartsWindowPosition
} = require('../renderer/src/lib/floating-layer.js');

test('clampToWindow clamps all four edges with default margin', (t) => {
  stubWindow(t, 420, 680);
  assert.deepEqual(clampToWindow(-50, -50, 100, 60), { x: 8, y: 8 });
  assert.deepEqual(clampToWindow(400, 660, 100, 60), { x: 312, y: 612 });
  assert.deepEqual(clampToWindow(100, 100, 100, 60), { x: 100, y: 100 });
});

test('clampToWindow falls back to margin when layer exceeds viewport', (t) => {
  stubWindow(t, 200, 200);
  assert.deepEqual(clampToWindow(50, 50, 400, 400), { x: 8, y: 8 });
});

test('resolveVerticalFlip prefers below when space allows', (t) => {
  stubWindow(t, 420, 680);
  const flip = resolveVerticalFlip({ top: 100, bottom: 130 }, 120);
  assert.equal(flip.below, true);
  assert.equal(flip.top, 136);
});

test('resolveVerticalFlip flips up when below does not fit', (t) => {
  stubWindow(t, 420, 680);
  const flip = resolveVerticalFlip({ top: 600, bottom: 630 }, 120);
  assert.equal(flip.below, false);
  assert.equal(flip.top, 600 - 6 - 120);
});

test('resolveVerticalFlip with prefer above stays above unless only below fits', (t) => {
  stubWindow(t, 420, 680);
  // 上方充足:保持 above(热力图默认行为)
  assert.equal(resolveVerticalFlip({ top: 300, bottom: 330 }, 140, { prefer: 'above' }).below, false);
  // 靠近顶部,上方不够而下方够:below
  assert.equal(resolveVerticalFlip({ top: 60, bottom: 90 }, 140, { prefer: 'above' }).below, true);
});

test('echartsWindowPosition converts container coords and clamps into window', (t) => {
  stubWindow(t, 420, 680);
  const dom = { getBoundingClientRect: () => ({ left: 20, top: 40 }) };
  const position = echartsWindowPosition(dom);
  const size = { contentSize: [150, 80] };
  // 容器内 (10, 10) → 页面 (20+10+14, 40+10+14) = (44, 64) → 返回容器坐标 (24, 24)
  assert.deepEqual(position([10, 10], null, null, null, size), [24, 24]);
  // 贴近右下:先翻到 -cw-14 / -ch-14,仍越界则钳到窗口内
  const [x, y] = position([390, 640], null, null, null, size);
  assert.equal(20 + x + 150 <= 420 - 8, true);
  assert.equal(40 + y + 80 <= 680 - 8, true);
  assert.equal(20 + x >= 8, true);
  assert.equal(40 + y >= 8, true);
});

test('echartsWindowPosition tolerates null dom', (t) => {
  stubWindow(t, 420, 680);
  const position = echartsWindowPosition(null);
  const size = { contentSize: [150, 80] };
  assert.deepEqual(position([10, 10], null, null, null, size), [24, 24]);
});
