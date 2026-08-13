const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 2026-08-05T04:00:00.000Z = 北京 2026-08-05 12:00:00,任意主机时区下北京结算日恒为 2026-08-05
const NOW = Date.parse('2026-08-05T04:00:00.000Z');

function loadRetention() {
  delete require.cache[require.resolve('../src/main/core/usage-retention')];
  return require('../src/main/core/usage-retention');
}

test('retention starts at the inclusive Beijing-calendar boundary for 3, 7, and 30 days', () => {
  const { retentionStartDay } = loadRetention();

  assert.equal(retentionStartDay(3, NOW), '2026-08-03');
  assert.equal(retentionStartDay(7, NOW), '2026-07-30');
  assert.equal(retentionStartDay(30, NOW), '2026-07-07');
  assert.equal(retentionStartDay(365, NOW), '2025-08-06');
});

test('normalizeHistoryDays accepts any positive integer and rejects invalid values', () => {
  const { normalizeHistoryDays } = loadRetention();

  assert.equal(normalizeHistoryDays(365), 365);
  assert.equal(normalizeHistoryDays('90'), 90);
  assert.equal(normalizeHistoryDays(0), null);
  assert.equal(normalizeHistoryDays(-3), null);
  assert.equal(normalizeHistoryDays(1.5), null);
  assert.equal(normalizeHistoryDays('abc'), null);
  assert.equal(normalizeHistoryDays(undefined), null);
});

test('usage filtering keeps only valid dated keys inside the configured window', () => {
  const { filterUsageDaily } = loadRetention();
  const input = {
    'codex:2026-07-06': { total: 1 },
    'codex:2026-07-07': { total: 2 },
    'kimi:2026-08-05': { total: 3 },
    'deepseek:2026-08-06': { total: 4 },
    malformed: { total: 5 }
  };

  const filtered = filterUsageDaily(input, 30, NOW);

  assert.deepEqual(filtered, {
    'codex:2026-07-07': { total: 2 },
    'kimi:2026-08-05': { total: 3 }
  });
  assert.notEqual(filtered, input);
  assert.equal(Object.keys(input).length, 5, 'filtering must not mutate its input');
});

test('physical cleanup mutates only usageDaily and preserves fetch markers plus local-log cursors', () => {
  const { pruneUsageDaily } = loadRetention();
  const cursor = { '/tmp/rollout.jsonl': { offset: 123, mtimeMs: 456 } };
  const kimiCursor = { '/tmp/wire.jsonl': { offset: 789, mtimeMs: 987 } };
  const fetchedMonths = ['2026-07', '2026-06'];
  const data = {
    'data.historyDays': 3,
    usageDaily: {
      'codex:2026-08-02': { total: 1 },
      'codex:2026-08-03': { total: 2 },
      'kimi:2026-08-05': { total: 3 }
    },
    'localLogCursors.codex': cursor,
    'localLogCursors.kimi': kimiCursor,
    'providers.deepseek.fetchedMonths': fetchedMonths
  };
  const writes = [];
  const store = {
    get(key) { return data[key]; },
    set(key, value) {
      writes.push([key, value]);
      data[key] = value;
    }
  };

  const removed = pruneUsageDaily(store, NOW);

  assert.equal(removed, 1);
  assert.deepEqual(data.usageDaily, {
    'codex:2026-08-03': { total: 2 },
    'kimi:2026-08-05': { total: 3 }
  });
  assert.deepEqual(writes.map((entry) => entry[0]), ['usageDaily']);
  assert.strictEqual(data['localLogCursors.codex'], cursor);
  assert.strictEqual(data['localLogCursors.kimi'], kimiCursor);
  assert.strictEqual(data['providers.deepseek.fetchedMonths'], fetchedMonths);
});

test('expired records remain filtered when a collector replays them after cleanup', () => {
  const { filterUsageDaily } = loadRetention();
  const replayed = {
    'codex:2026-08-01': { total: 100 },
    'codex:2026-08-05': { total: 10 }
  };

  assert.deepEqual(filterUsageDaily(replayed, 3, NOW), {
    'codex:2026-08-05': { total: 10 }
  });
});

test('both local-log providers filter rolled-up records before merging unless retainAll (full rescan)', () => {
  ['codex', 'kimi'].forEach((provider) => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/main/providers/' + provider + '/locallog.js'),
      'utf8'
    );
    assert.match(source, /require\('\.\.\/\.\.\/core\/usage-retention'\)/);
    assert.match(source, /const rolled = rollupDaily\(records, diagnostics, nowMs\);/);
    assert.match(
      source,
      /opts && opts\.retainAll\s*\?\s*rolled\s*:\s*filterUsageDaily\(rolled, store\.get\('data\.historyDays'\), nowMs\)/
    );
    assert.match(source, /scanFileBatch\(\{/);
    assert.match(source, /cursorKey:\s*CURSOR_KEY/);
  });
});

test('DeepSeek persistence filters expired days without clearing fetched-month markers', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/providers/deepseek/index.js'),
    'utf8'
  );

  assert.match(source, /require\('\.\.\/\.\.\/core\/usage-retention'\)/);
  assert.match(
    source,
    /if \(!isRetainedDay\(d\.date, store\.get\('data\.historyDays'\)\)\) return;/
  );
  assert.match(source, /const done = new Set\(store\.get\(FETCHED_MONTHS_KEY\) \|\| \[\]\);/);
  assert.doesNotMatch(source, /delete\(FETCHED_MONTHS_KEY\)|set\(FETCHED_MONTHS_KEY, \[\]\)/);
});

test('retention setting changes and startup cleanup use the same physical boundary', () => {
  const bootstrapSource = fs.readFileSync(
    path.resolve(__dirname, '../src/main/bootstrap.js'),
    'utf8'
  );
  const writerSource = fs.readFileSync(
    path.resolve(__dirname, '../src/main/core/settings-write.js'),
    'utf8'
  );

  assert.match(bootstrapSource, /const \{ pruneUsageDaily \} = require\('\.\/core\/usage-retention'\);/);
  assert.match(
    bootstrapSource,
    /afterInitialize:\s*\(\)\s*=>\s*pruneUsageDaily\(storeModule\)/
  );
  assert.match(bootstrapSource, /loadMain:\s*\(\)\s*=>\s*require\('\.\/index'\)/);
  assert.match(writerSource, /const \{ pruneUsageDaily, normalizeHistoryDays \} = require\('\.\/usage-retention'\);/);
  assert.match(
    writerSource,
    /if \(targetKey === 'data\.historyDays'\) \{\s*pruneUsageDaily\(deps\.store\);\s*\}/
  );
});

test('startup cleanup runs after store initialization and before the main process loads', async () => {
  const { runStoreBootstrap } = require('../src/main/core/startup-recovery');
  const sequence = [];

  const result = await runStoreBootstrap({
    app: {
      getPath() {
        sequence.push('getPath');
        return '/safe/user-data';
      }
    },
    dialog: {},
    shell: {},
    storeModule: {
      initialize() {
        sequence.push('initialize');
      }
    },
    afterInitialize() {
      sequence.push('prune');
    },
    loadMain() {
      sequence.push('loadMain');
    },
    logger: { error() { throw new Error('success path must not log'); } }
  });

  assert.deepEqual(sequence, ['getPath', 'initialize', 'prune', 'loadMain']);
  assert.deepEqual(result, { started: true });
});
