const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resetSettingsStore } = require('../src/main/core/settings-reset');
const { readLocalLog } = require('../src/main/providers/codex/locallog');

class MemoryStore {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries));
  }

  get(key) {
    return this.values.get(key);
  }

  set(key, value) {
    this.values.set(key, structuredClone(value));
  }

  delete(key) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

function totalForProvider(store, providerId) {
  const usageDaily = store.get('usageDaily') || {};
  return Object.entries(usageDaily)
    .filter(([key]) => key.startsWith(providerId + ':'))
    .reduce((sum, [, value]) => sum + (Number(value && value.total) || 0), 0);
}

function writeCodexRecord(root) {
  const sessionDir = path.join(root, '2026', '08', '05');
  fs.mkdirSync(sessionDir, { recursive: true });
  const record = {
    type: 'event_msg',
    timestamp: '2026-08-05T08:00:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 5,
          cached_input_tokens: 1,
          output_tokens: 7,
          reasoning_output_tokens: 0,
          total_tokens: 12
        }
      }
    }
  };
  fs.writeFileSync(
    path.join(sessionDir, 'rollout-reset-integrity.jsonl'),
    JSON.stringify(record) + '\n'
  );
}

test('reset preserves Codex aggregate and its compatible scan cursor as one data unit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-codex-reset-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeCodexRecord(root);

  const store = new MemoryStore({
    'providers.codex.localLogRoot': root,
    'providers.deepseek.apiKey': 'preserved-key',
    'providers.deepseek.sessionToken': 'preserved-session',
    'providers.proxyUrl': 'http://127.0.0.1:7890',
    usageDaily: {},
    'window.opacity': 55
  });

  const firstRecords = readLocalLog({ store });
  assert.equal(firstRecords.length, 1);
  assert.equal(totalForProvider(store, 'codex'), 12);
  const firstCursor = structuredClone(store.get('localLogCursors.codex'));
  assert.ok(firstCursor && Object.keys(firstCursor).length === 1);

  for (let resetCount = 0; resetCount < 2; resetCount += 1) {
    resetSettingsStore(store);

    assert.equal(totalForProvider(store, 'codex'), 12);
    assert.deepEqual(store.get('localLogCursors.codex'), firstCursor);
    assert.equal(store.get('providers.deepseek.apiKey'), 'preserved-key');
    assert.equal(store.get('providers.deepseek.sessionToken'), 'preserved-session');
    assert.equal(store.get('window.opacity'), undefined);

    // The localLogRoot override is test-only configuration and is intentionally reset.
    store.set('providers.codex.localLogRoot', root);
    const repeatedRecords = readLocalLog({ store });
    assert.equal(repeatedRecords.length, 0);
    assert.equal(totalForProvider(store, 'codex'), 12);
  }
});

test('reset does not broaden Issue #8 into Kimi cursor or migration policy', () => {
  const store = new MemoryStore({
    usageDaily: { 'codex:2026-08-05': { total: 12 } },
    'localLogCursors.codex': { codexFile: { offset: 100, mtimeMs: 200 } },
    'localLogCursors.kimi': { kimiFile: { offset: 300, mtimeMs: 400 } },
    'localLogMigrations.kimiTotalIncludesCached': true
  });

  resetSettingsStore(store);

  assert.deepEqual(store.get('localLogCursors.codex'), {
    codexFile: { offset: 100, mtimeMs: 200 }
  });
  assert.equal(store.get('localLogCursors.kimi'), undefined);
  assert.equal(store.get('localLogMigrations.kimiTotalIncludesCached'), undefined);
});
