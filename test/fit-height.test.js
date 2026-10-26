const test = require('node:test');
const assert = require('node:assert/strict');

test('grid auto-fit returns to the preset height when content does not overflow', async () => {
  const { fitGridItemHeight } = await import('../renderer/src/grid/fit-height.js');

  // 即使当前内容已经因之前的计算长到 960px,只要没有真实溢出,
  // 下一轮也必须回到 6 格,不能把当前高度继续当作新的需求。
  assert.equal(fitGridItemHeight({
    base: 6,
    cell: 24,
    padding: 16,
    scrollHeight: 960,
    clientHeight: 960
  }), 6);

  for (let index = 0; index < 20; index += 1) {
    assert.equal(fitGridItemHeight({
      base: 6,
      cell: 24,
      padding: 16,
      scrollHeight: 144,
      clientHeight: 144
    }), 6);
  }
});

test('grid auto-fit grows only for real overflow and preserves the minimum', async () => {
  const { fitGridItemHeight } = await import('../renderer/src/grid/fit-height.js');

  assert.equal(fitGridItemHeight({
    base: 6,
    cell: 24,
    padding: 16,
    scrollHeight: 220,
    clientHeight: 140
  }), 10);
  assert.equal(fitGridItemHeight({
    base: 8,
    cell: 24,
    padding: 16,
    scrollHeight: 145,
    clientHeight: 144
  }), 8);
  assert.equal(fitGridItemHeight({ base: 6, cell: 0 }), 6);
});

test('grid auto-fit retains the measured requirement until content is invalidated', async () => {
  const { fitGridItemHeight } = await import('../renderer/src/grid/fit-height.js');
  const overflowing = fitGridItemHeight({
    base: 4,
    cell: 24,
    padding: 18,
    scrollHeight: 84,
    clientHeight: 78
  });
  assert.equal(overflowing, 5);

  for (let index = 0; index < 20; index += 1) {
    assert.equal(fitGridItemHeight({
      base: 4,
      cell: 24,
      padding: 18,
      scrollHeight: 102,
      clientHeight: 102,
      retainedHeight: overflowing
    }), 5);
  }

  // 内容、主题或宽度变化后清除 retainedHeight,才允许重新探测基准高度。
  assert.equal(fitGridItemHeight({
    base: 4,
    cell: 24,
    padding: 18,
    scrollHeight: 102,
    clientHeight: 102
  }), 4);
});

test('grid auto-fit commits final sizes before restoring user animation', async () => {
  const { applyGridItemHeights } = await import('../renderer/src/grid/fit-height.js');
  const calls = [];
  const itemEl = { id: 'today-cost-card' };
  const grid = {
    opts: { animate: true },
    setAnimation(...args) { calls.push(['animation', ...args]); },
    update(el, { h }) { calls.push(['update', el.id, h]); }
  };
  const host = {
    get offsetHeight() {
      calls.push(['reflow']);
      return 120;
    }
  };

  applyGridItemHeights(grid, host, [{ itemEl, h: 4 }]);
  assert.deepEqual(calls, [
    ['animation', false],
    ['update', 'today-cost-card', 4],
    ['reflow'],
    ['animation', true, true]
  ]);

  applyGridItemHeights(grid, host, []);
  assert.equal(calls.length, 4);
});

test('today-card decoration overflow is clipped outside measured content', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const card = fs.readFileSync(path.join(root, 'renderer/src/components/FeeCard.jsx'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'renderer/src/styles.css'), 'utf8');

  assert.match(card, /className="fee-card-decorations" aria-hidden="true">\s*<span className="shen-deco shen-bite b1"/);
  assert.match(styles, /\.fee-card-decorations\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*overflow:\s*hidden;/s);
});
