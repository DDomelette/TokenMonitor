const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseRolloutLine } = require('../src/main/providers/codex/locallog');
const { parseWireLine, readLocalLog: readKimiLocalLog } = require('../src/main/providers/kimi/locallog');
const { rollupDaily, localDayStr } = require('../src/main/core/locallog');

function kimiLine(time, input = 10) {
  const payload = {
    type: 'usage.record',
    model: 'kimi-code/k3-256k',
    usage: {
      inputOther: input,
      inputCacheRead: 2,
      output: 3
    }
  };
  if (time !== undefined) payload.time = time;
  return JSON.stringify(payload);
}

function codexLine(timestamp, input = 10) {
  const payload = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: 2,
          output_tokens: 3,
          total_tokens: input + 3
        }
      }
    }
  };
  if (timestamp !== undefined) payload.timestamp = timestamp;
  return JSON.stringify(payload);
}

function diagnostics() {
  return { skippedInvalidTimestamps: 0 };
}

test('Kimi parser rejects invalid timestamps and counts only otherwise-valid usage records', () => {
  const now = Date.now();
  const invalid = [
    undefined,
    null,
    0,
    -1,
    'not-a-number',
    Date.UTC(1999, 11, 31, 23, 59, 59),
    now + 48 * 60 * 60 * 1000
  ];

  invalid.forEach((value) => {
    const diag = diagnostics();
    assert.equal(parseWireLine(kimiLine(value), diag), null, String(value));
    assert.equal(diag.skippedInvalidTimestamps, 1, String(value));
  });

  const irrelevant = diagnostics();
  assert.equal(
    parseWireLine(JSON.stringify({ type: 'other', time: 0, usage: {} }), irrelevant),
    null
  );
  assert.equal(irrelevant.skippedInvalidTimestamps, 0);
});

test('Codex parser rejects invalid, ancient, and far-future timestamps with diagnostics', () => {
  const invalid = [
    undefined,
    '',
    'not-a-date',
    '1999-12-31T23:59:59.000Z',
    new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  ];

  invalid.forEach((value) => {
    const diag = diagnostics();
    assert.equal(parseRolloutLine(codexLine(value), diag), null, String(value));
    assert.equal(diag.skippedInvalidTimestamps, 1, String(value));
  });
});

test('rollupDaily skips invalid timestamps instead of assigning them to today', () => {
  const validTs = Date.now() - 60 * 1000;
  const diag = diagnostics();
  const records = [
    { provider: 'kimi', ts: validTs, usage: { input: 5, output: 2, total: 7 } },
    { provider: 'kimi', ts: null, usage: { input: 100, output: 100, total: 200 } },
    { provider: 'kimi', ts: 0, usage: { input: 100, output: 100, total: 200 } },
    { provider: 'kimi', ts: 'NaN', usage: { input: 100, output: 100, total: 200 } },
    { provider: 'kimi', ts: Date.UTC(1999, 0, 1), usage: { input: 100, output: 100, total: 200 } },
    { provider: 'kimi', ts: Date.now() + 48 * 60 * 60 * 1000, usage: { input: 100, output: 100, total: 200 } }
  ];

  const rolled = rollupDaily(records, diag);
  const validKey = 'kimi:' + localDayStr(validTs);

  assert.deepEqual(Object.keys(rolled), [validKey]);
  assert.deepEqual(rolled[validKey], { input: 5, cached: 0, output: 2, total: 7 });
  assert.equal(diag.skippedInvalidTimestamps, 5);
});

test('Kimi scan consumes invalid lines once, reports their count, and aggregates only valid data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-invalid-ts-'));
  const file = path.join(dir, 'wire.jsonl');
  const now = Date.now();
  const data = {
    'providers.kimi.localLogRoot': dir,
    'localLogMigrations.kimiTotalIncludesCached': true,
    'data.historyDays': 7
  };
  const store = {
    get(key) { return data[key]; },
    set(key, value) { data[key] = value; }
  };

  try {
    fs.writeFileSync(file, [
      kimiLine(undefined),
      kimiLine(0),
      kimiLine('bad-time'),
      kimiLine(now, 20)
    ].join('\n') + '\n');

    const records = readKimiLocalLog({ store });
    assert.equal(records.length, 1);
    assert.equal(records[0].usage.input, 20);
    assert.equal(records.diagnostics.skippedInvalidTimestamps, 3);
    assert.equal(Object.keys(records).includes('diagnostics'), false);

    const dayKey = 'kimi:' + localDayStr(now);
    assert.deepEqual(data.usageDaily[dayKey], {
      input: 20,
      cached: 2,
      output: 3,
      total: 25
    });

    const second = readKimiLocalLog({ store });
    assert.equal(second.length, 0);
    assert.equal(second.diagnostics.skippedInvalidTimestamps, 0);
    assert.deepEqual(data.usageDaily[dayKey], {
      input: 20,
      cached: 2,
      output: 3,
      total: 25
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
