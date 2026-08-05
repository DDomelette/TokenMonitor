const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  localDayStr,
  rollupDaily
} = require('../src/main/core/locallog');
const {
  parseRolloutLine
} = require('../src/main/providers/codex/locallog');
const {
  parseWireLine,
  readLocalLog: readKimiLocalLog
} = require('../src/main/providers/kimi/locallog');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 7, 5, 12, 0, 0, 0);
const TOO_OLD_MS = Date.UTC(1999, 11, 31, 23, 59, 59, 999);

function kimiLine(time, includeTime = true) {
  const record = {
    type: 'usage.record',
    model: 'kimi-code/k3-256k',
    usage: {
      inputOther: 10,
      inputCacheRead: 5,
      output: 2
    }
  };
  if (includeTime) record.time = time;
  return JSON.stringify(record);
}

function codexLine(timestamp, includeTimestamp = true) {
  const record = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 5,
          output_tokens: 2,
          total_tokens: 12
        }
      }
    }
  };
  if (includeTimestamp) record.timestamp = timestamp;
  return JSON.stringify(record);
}

function makeStore(initial) {
  const values = Object.assign({}, initial);
  return {
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; },
    values
  };
}

test('Kimi parser rejects invalid and implausible timestamps with diagnostics', () => {
  const diagnostics = {};
  const invalidLines = [
    kimiLine(undefined, false),
    kimiLine(0),
    kimiLine('not-a-number'),
    kimiLine(TOO_OLD_MS),
    kimiLine(NOW_MS + DAY_MS + 1)
  ];

  invalidLines.forEach((line) => {
    assert.equal(parseWireLine(line, diagnostics, NOW_MS), null);
  });

  const valid = parseWireLine(kimiLine(String(NOW_MS)), diagnostics, NOW_MS);
  assert.ok(valid);
  assert.equal(valid.ts, NOW_MS);
  assert.equal(diagnostics.invalidTimestamp, 5);
});

test('Codex parser rejects invalid and implausible timestamps with diagnostics', () => {
  const diagnostics = {};
  const invalidLines = [
    codexLine(undefined, false),
    codexLine(0),
    codexLine('not-a-date'),
    codexLine(new Date(TOO_OLD_MS).toISOString()),
    codexLine(new Date(NOW_MS + DAY_MS + 1).toISOString())
  ];

  invalidLines.forEach((line) => {
    assert.equal(parseRolloutLine(line, diagnostics, NOW_MS), null);
  });

  const valid = parseRolloutLine(
    codexLine(new Date(NOW_MS).toISOString()),
    diagnostics,
    NOW_MS
  );
  assert.ok(valid);
  assert.equal(valid.ts, NOW_MS);
  assert.equal(diagnostics.invalidTimestamp, 5);
});

test('rollupDaily skips invalid timestamps instead of assigning them to now', () => {
  const diagnostics = {};
  const records = [
    { provider: 'kimi', ts: null, usage: { input: 100 } },
    { provider: 'kimi', ts: 0, usage: { input: 100 } },
    { provider: 'kimi', ts: Number.NaN, usage: { input: 100 } },
    { provider: 'kimi', ts: TOO_OLD_MS, usage: { input: 100 } },
    { provider: 'kimi', ts: NOW_MS + DAY_MS + 1, usage: { input: 100 } },
    {
      provider: 'kimi',
      ts: NOW_MS,
      usage: { input: 10, cached: 5, output: 2, total: 17 }
    }
  ];

  const result = rollupDaily(records, diagnostics, NOW_MS);
  assert.deepEqual(result, {
    [`kimi:${localDayStr(NOW_MS)}`]: {
      input: 10,
      cached: 5,
      output: 2,
      total: 17
    }
  });
  assert.equal(diagnostics.invalidTimestamp, 5);
});

test('Kimi scanning counts invalid timestamp lines once and advances the cursor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-invalid-ts-'));
  const file = path.join(root, 'wire.jsonl');
  const nowMs = Date.now();
  const diagnostics = {};
  const store = makeStore({
    'providers.kimi.localLogRoot': root,
    'localLogMigrations.kimiTotalIncludesCached': true,
    'data.historyDays': 30,
    usageDaily: {}
  });

  try {
    const lines = [
      kimiLine(undefined, false),
      kimiLine(0),
      kimiLine('bad'),
      kimiLine(TOO_OLD_MS),
      kimiLine(nowMs + DAY_MS + 1),
      kimiLine(nowMs)
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const first = readKimiLocalLog(
      { store },
      { diagnostics, nowMs }
    );
    assert.equal(first.length, 1);
    assert.equal(first[0].ts, nowMs);
    assert.equal(diagnostics.invalidTimestamp, 5);
    assert.deepEqual(store.get('usageDaily')[`kimi:${localDayStr(nowMs)}`], {
      input: 10,
      cached: 5,
      output: 2,
      total: 17
    });

    const second = readKimiLocalLog(
      { store },
      { diagnostics, nowMs }
    );
    assert.equal(second.length, 0);
    assert.equal(diagnostics.invalidTimestamp, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
