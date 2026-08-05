const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const codex = require('../src/main/providers/codex/locallog');
const kimi = require('../src/main/providers/kimi/locallog');

const NOW_MS = Date.UTC(2026, 7, 5, 12, 0, 0, 0);

function makeStore(initial) {
  const values = Object.assign({}, initial);
  return {
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; }
  };
}

function withCountedNow(run) {
  const originalNow = Date.now;
  let reads = 0;
  Date.now = () => {
    reads += 1;
    return NOW_MS;
  };
  try {
    const result = run();
    return { result, reads };
  } finally {
    Date.now = originalNow;
  }
}

test('Codex local-log read snapshots one evaluation time for scan, rollup, and retention', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-codex-now-'));
  const file = path.join(root, 'rollout-test.jsonl');
  const line = JSON.stringify({
    timestamp: new Date(NOW_MS).toISOString(),
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
  });
  const store = makeStore({
    'providers.codex.localLogRoot': root,
    'data.historyDays': 30,
    usageDaily: {}
  });

  try {
    fs.writeFileSync(file, line + '\n');
    const { result, reads } = withCountedNow(() => codex.readLocalLog({ store }));
    assert.equal(result.length, 1);
    assert.equal(reads, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi local-log read snapshots one evaluation time for scan, rollup, and retention', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-kimi-now-'));
  const file = path.join(root, 'wire.jsonl');
  const line = JSON.stringify({
    time: NOW_MS,
    type: 'usage.record',
    model: 'kimi-code/k3-256k',
    usage: {
      inputOther: 10,
      inputCacheRead: 5,
      output: 2
    }
  });
  const store = makeStore({
    'providers.kimi.localLogRoot': root,
    'localLogMigrations.kimiTotalIncludesCached': true,
    'data.historyDays': 30,
    usageDaily: {}
  });

  try {
    fs.writeFileSync(file, line + '\n');
    const { result, reads } = withCountedNow(() => kimi.readLocalLog({ store }));
    assert.equal(result.length, 1);
    assert.equal(reads, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
