const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resetSettingsStore } = require('../src/main/core/settings-reset');
const { readLocalLog } = require('../src/main/providers/kimi/locallog');

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

  clear() {
    this.values.clear();
  }
}

function writeKimiRecord(root) {
  const sessionDir = path.join(root, '2026', '08', '05');
  fs.mkdirSync(sessionDir, { recursive: true });
  const record = {
    type: 'usage.record',
    time: Date.UTC(2026, 7, 5, 8, 0, 0),
    model: 'kimi-k2',
    usage: {
      inputOther: 5,
      inputCacheRead: 2,
      output: 3
    }
  };
  fs.writeFileSync(
    path.join(sessionDir, 'wire.jsonl'),
    JSON.stringify(record) + '\n'
  );
}

function kimiHistory(store) {
  const usageDaily = store.get('usageDaily') || {};
  return Object.fromEntries(
    Object.entries(usageDaily)
      .filter(([key]) => key.startsWith('kimi:'))
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function kimiTotal(store) {
  return Object.values(kimiHistory(store))
    .reduce((sum, value) => sum + (Number(value && value.total) || 0), 0);
}

test('settings reset preserves Kimi migration state and history no longer present on disk', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-kimi-reset-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeKimiRecord(root);

  const legacyHistoryKey = 'kimi:2020-01-02';
  const store = new MemoryStore({
    'providers.kimi.localLogRoot': root,
    usageDaily: {
      [legacyHistoryKey]: {
        input: 70,
        cached: 9,
        output: 20,
        total: 99
      }
    },
    'localLogMigrations.kimiTotalIncludesCached': true,
    'window.opacity': 55
  });

  const firstRecords = await readLocalLog({ store });
  assert.equal(firstRecords.length, 1);
  assert.equal(kimiTotal(store), 109);
  assert.equal(store.get('usageDaily')[legacyHistoryKey].total, 99);

  const expectedHistory = structuredClone(kimiHistory(store));
  const expectedCursor = structuredClone(store.get('localLogCursors.kimi'));
  assert.ok(expectedCursor && Object.keys(expectedCursor).length === 1);

  for (let resetCount = 0; resetCount < 2; resetCount += 1) {
    resetSettingsStore(store);

    store.set('providers.kimi.localLogRoot', root);
    const repeatedRecords = await readLocalLog({ store });

    assert.equal(repeatedRecords.length, 0);
    assert.deepEqual(kimiHistory(store), expectedHistory);
    assert.equal(store.get('usageDaily')[legacyHistoryKey].total, 99);
    assert.equal(kimiTotal(store), 109);
    assert.equal(store.get('localLogMigrations.kimiTotalIncludesCached'), true);
    assert.deepEqual(store.get('localLogCursors.kimi'), expectedCursor);
    assert.equal(store.get('window.opacity'), undefined);
  }
});
