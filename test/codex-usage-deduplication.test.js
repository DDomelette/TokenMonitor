// Codex rollout-*.jsonl 的 total_token_usage 是会话累计快照,同一累计值在文件中
// 会出现多次(同一 turn 的重复 token_count 事件)。扫描器须按文件游标中的
// lastUsageTotal 抑制重复累计,只统计真正的新增累计。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanFileBatch, rollupDaily } = require('../src/main/core/locallog');
const { parseRolloutLine } = require('../src/main/providers/codex/locallog');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-codex-dedupe-'));
}

function makeCursorStore() {
  const data = {};
  return { data, get(k) { return data[k]; }, set(k, v) { data[k] = v; } };
}

// tokenEvent(timestamp, cumulativeTotal, deltaTokens):
// total_token_usage.total_tokens 为会话累计,last_token_usage.total_tokens 为单次增量
function tokenEvent(timestamp, cumulativeTotal, deltaTokens) {
  return JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: deltaTokens,
          output_tokens: 0,
          total_tokens: deltaTokens
        },
        total_token_usage: { total_tokens: cumulativeTotal }
      }
    }
  }) + '\n';
}

function codexScan(dir, cursorStore, options) {
  return scanFileBatch(Object.assign({
    root: dir,
    match: /rollout-.*\.jsonl$/,
    cursorStore,
    cursorKey: 'cursor.codex-dedupe',
    providerId: 'codex',
    parseLine: parseRolloutLine
  }, options));
}

test('Codex duplicate cumulative snapshots are counted once', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-dedupe.jsonl');
  const cursorStore = makeCursorStore();
  const events = [
    tokenEvent('2026-08-11T01:00:00Z', 10, 10),
    tokenEvent('2026-08-11T01:00:01Z', 10, 10),
    tokenEvent('2026-08-11T01:00:02Z', 15, 5)
  ];
  try {
    fs.writeFileSync(file, events.join(''));
    const batch = await codexScan(dir, cursorStore);
    assert.equal(batch.records.length, 2);
    const daily = rollupDaily(batch.records);
    assert.equal(daily['codex:2026-08-11'].total, 15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex dedupe state survives separate byte-budget batches', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-dedupe-chunked.jsonl');
  const cursorStore = makeCursorStore();
  const events = [
    tokenEvent('2026-08-11T01:00:00Z', 10, 10),
    tokenEvent('2026-08-11T01:00:01Z', 10, 10),
    tokenEvent('2026-08-11T01:00:02Z', 15, 5)
  ];
  try {
    fs.writeFileSync(file, events.join(''));

    const first = await codexScan(dir, cursorStore, { maxBytesPerScan: Buffer.byteLength(events[0]) });
    assert.equal(first.records.length, 1);
    assert.equal(first.complete, false);

    const second = await codexScan(dir, cursorStore, { maxBytesPerScan: Buffer.byteLength(events[1]) });
    assert.equal(second.records.length, 0, 'cursor lastUsageTotal must suppress the duplicate snapshot');
    assert.equal(second.complete, false);

    const third = await codexScan(dir, cursorStore, { maxBytesPerScan: 4096 });
    assert.equal(third.records.length, 1);
    assert.equal(third.complete, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cumulative decrease counts the reset record', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-reset.jsonl');
  const cursorStore = makeCursorStore();
  try {
    fs.writeFileSync(file, tokenEvent('2026-08-11T02:00:00Z', 20, 8));
    const first = await codexScan(dir, cursorStore);
    assert.equal(first.records.length, 1);

    fs.appendFileSync(file, tokenEvent('2026-08-11T02:01:00Z', 4, 4));
    const second = await codexScan(dir, cursorStore);
    assert.equal(second.records.length, 1, 'a cumulative decrease is a new session and must count');
    assert.equal(second.records[0].usage.total, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing total_token_usage counts every record normally', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-no-cumulative.jsonl');
  const cursorStore = makeCursorStore();
  const line = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-11T03:00:00Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }
      }
    }
  }) + '\n';
  try {
    fs.writeFileSync(file, line + line);
    const batch = await codexScan(dir, cursorStore);
    assert.equal(batch.records.length, 2, 'records without a cumulative snapshot are never deduplicated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('truncation clears lastUsageTotal and allows the first new record', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-truncate.jsonl');
  const cursorStore = makeCursorStore();
  try {
    fs.writeFileSync(
      file,
      tokenEvent('2026-08-11T04:00:00Z', 30, 6) + tokenEvent('2026-08-11T04:01:00Z', 32, 2)
    );
    const first = await codexScan(dir, cursorStore);
    assert.equal(first.records.length, 2);

    // 截断为单个更短的记录:文件变短触发从头重读,lastUsageTotal 必须被清除
    fs.writeFileSync(file, tokenEvent('2026-08-11T05:00:00Z', 30, 9));
    const second = await codexScan(dir, cursorStore);
    assert.equal(second.records.length, 1, 'truncation must reset lastUsageTotal');
    assert.equal(second.records[0].usage.total, 9);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
