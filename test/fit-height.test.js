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
