const test = require('node:test');
const assert = require('node:assert/strict');
const { blockCount, MAX_HEATMAP_BLOCKS } = require('../renderer/src/lib/heatmap.js');

test('blockCount: 零值与非法 scale 返回 0', () => {
  assert.equal(blockCount(0, 10), 0);
  assert.equal(blockCount(5, 0), 0);
  assert.equal(blockCount(-3, 10), 0);
});

test('blockCount: value>0 至少 1 块,按比例取整,封顶 MAX_HEATMAP_BLOCKS', () => {
  assert.equal(MAX_HEATMAP_BLOCKS, 10);
  assert.equal(blockCount(1, 10), 1);
  assert.equal(blockCount(50, 10), 5);
  assert.equal(blockCount(100, 10), 10);
  assert.equal(blockCount(999, 10), 10);
});
