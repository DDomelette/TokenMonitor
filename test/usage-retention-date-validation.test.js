const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterUsageDaily,
  isRetainedDay
} = require('../src/main/core/usage-retention');

const NOW = new Date(2026, 7, 5, 12, 0, 0, 0).getTime();

test('retention rejects impossible calendar dates even when their strings fall inside the window', () => {
  assert.equal(isRetainedDay('2026-07-32', 30, NOW), false);
  assert.equal(isRetainedDay('2026-08-00', 30, NOW), false);
  assert.equal(isRetainedDay('2026-02-29', 365, NOW), false);
  assert.equal(isRetainedDay('2024-02-29', 1000, NOW), true);

  assert.deepEqual(filterUsageDaily({
    'codex:2026-07-32': { total: 1 },
    'kimi:2026-08-00': { total: 2 },
    'deepseek:2026-08-05': { total: 3 }
  }, 30, NOW), {
    'deepseek:2026-08-05': { total: 3 }
  });
});
