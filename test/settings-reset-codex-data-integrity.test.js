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

test('reset preserves Codex aggregate and its compatible scan cursor as one data unit', async (t) => {
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

  const firstRecords = await readLocalLog({ store });
  assert.equal(firstRecords.records.length, 1);
  assert.equal(firstRecords.complete, true);
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

    store.set('providers.codex.localLogRoot', root);
    const repeatedRecords = await readLocalLog({ store });
    assert.equal(repeatedRecords.records.length, 0);
    assert.equal(repeatedRecords.complete, true);
    assert.equal(totalForProvider(store, 'codex'), 12);
  }
});

test('settings reset IPC delegates to the tested reset policy', () => {
  const ipcSource = fs.readFileSync(
    path.resolve(__dirname, '../src/main/ipc.js'),
    'utf8'
  );

  assert.match(
    ipcSource,
    /const \{ resetSettingsStore \} = require\('\.\/core\/settings-reset'\);/
  );
  assert.match(
    ipcSource,
    /ipcMain\.on\('settings:reset', \(\) => \{\s*resetSettingsStore\(deps\.store\);/
  );
});
function writeCodexUuidRecord(root, uuid) {
  const sessionDir = path.join(root, '2026', '08', '06');
  fs.mkdirSync(sessionDir, { recursive: true });
  const record = {
    type: 'event_msg',
    timestamp: '2026-08-06T08:00:00.000Z',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 3,
          cached_input_tokens: 1,
          output_tokens: 4,
          reasoning_output_tokens: 0,
          total_tokens: 7
        }
      }
    }
  };
  fs.writeFileSync(
    path.join(sessionDir, `rollout-2026-08-06T08-00-00-${uuid}.jsonl`),
    JSON.stringify(record) + '\n'
  );
}

test('reset preserves a UUID-keyed Codex cursor and its aggregate', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-codex-uuid-reset-'));
  const archive = path.join(root, 'archive');
  fs.mkdirSync(archive, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const uuid = '019fe62f-9a3c-7cb2-9e34-f21173cf257d';
  writeCodexUuidRecord(root, uuid);

  const store = new MemoryStore({
    'providers.codex.localLogRoot': root,
    'providers.codex.archivedLogRoot': archive,
    'localLogMigrations.codexArchiveUuidCursorV1': true,
    usageDaily: {}
  });

  const firstRecords = await readLocalLog({ store });
  assert.equal(firstRecords.records.length, 1);
  assert.equal(totalForProvider(store, 'codex'), 7);
  assert.ok(store.get('localLogCursors.codex')[uuid]);

  resetSettingsStore(store);

  assert.equal(totalForProvider(store, 'codex'), 7);
  assert.ok(store.get('localLogCursors.codex')[uuid]);
  // 汇总、UUID 游标与迁移完成标记是同一份持久单元,必须一起保留
  assert.equal(store.get('localLogMigrations.codexArchiveUuidCursorV1'), true);

  store.set('providers.codex.localLogRoot', root);
  store.set('providers.codex.archivedLogRoot', archive);
  // 迁移标记已随重置保留,无需重新写入

  const repeatedRecords = await readLocalLog({ store });
  assert.equal(repeatedRecords.records.length, 0);
  assert.equal(totalForProvider(store, 'codex'), 7);
});