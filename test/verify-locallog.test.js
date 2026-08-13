const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMemoryCursorStore,
  scanAllBatches
} = require('../scripts/verify-locallog');

test('verification scan keeps its cursor and reads every batch', async () => {
  const cursorStore = createMemoryCursorStore();
  const seenOffsets = [];
  const scan = async (options) => {
    const cursor = options.cursorStore.get(options.cursorKey) || { offset: 0 };
    seenOffsets.push(cursor.offset);
    const nextOffset = cursor.offset + 1;
    options.cursorStore.set(options.cursorKey, { offset: nextOffset });
    return {
      records: [{ ts: nextOffset, usage: { total: nextOffset } }],
      complete: nextOffset === 3,
      bytesRead: 10
    };
  };

  const result = await scanAllBatches({ cursorStore, cursorKey: 'verify' }, scan);

  assert.deepEqual(seenOffsets, [0, 1, 2]);
  assert.equal(result.complete, true);
  assert.equal(result.passes, 3);
  assert.equal(result.bytesRead, 30);
  assert.deepEqual(result.records.map((record) => record.usage.total), [1, 2, 3]);
});
