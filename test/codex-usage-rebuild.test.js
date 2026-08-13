// Task 4: transactional shadow rebuild tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CODEX_ARCHIVE_MIGRATION_KEY,
  buildCodexShadow,
  replaceCodexSnapshot,
  rebuildCodexUsage
} = require('../src/main/providers/codex/rebuild');
const {
  liveStoreConfigPath,
  readStoreProjection,
  verifyCodexArchiveUsage
} = require('../scripts/verify-codex-archive-usage');

const NOW_MS = Date.UTC(2026, 7, 13, 12, 0, 0);
const UUID_ACTIVE = '019fe62f-0000-7000-8000-000000000001';
const UUID_ARCHIVE = '019fe62f-0000-7000-8000-000000000002';

function tokenLine({ ts, input = 0, cached = 0, output = 0, reasoning = 0, total = 0 }) {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          total_tokens: total
        }
      }
    },
    timestamp: ts
  });
}

function usageLine(opts) {
  return tokenLine(opts) + '\n';
}

function localDayKey(dateStr) {
  const date = new Date(dateStr);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function makeTempRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-rebuild-'));
  const sessions = path.join(base, 'sessions');
  const archived = path.join(base, 'archived_sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  return { base, sessions, archived };
}

const EVENTS = {
  A: { ts: '2026-08-09T10:00:00.000Z', input: 10, cached: 1, output: 2, reasoning: 3, total: 16 },
  B: { ts: '2026-08-10T10:00:00.000Z', input: 20, cached: 2, output: 3, reasoning: 4, total: 29 },
  C: { ts: '2026-08-10T11:00:00.000Z', input: 30, cached: 3, output: 4, reasoning: 5, total: 42 },
  OLD: { ts: '2026-07-20T10:00:00.000Z', input: 40, cached: 4, output: 5, reasoning: 6, total: 55 }
};

// ---------------------------------------------------------------------------
// Step 1: full-rebuild dedupe.
// ---------------------------------------------------------------------------

test('buildCodexShadow rebuilds both roots counting each event once', async () => {
  const { base, sessions, archived } = makeTempRoots();
  try {
    const activeContent = usageLine(EVENTS.A) + usageLine(EVENTS.B) + usageLine(EVENTS.A) + usageLine(EVENTS.OLD);
    const archiveContent = usageLine(EVENTS.B) + usageLine(EVENTS.C);
    const activeFile = path.join(sessions, `rollout-2026-08-09T10-00-00-${UUID_ACTIVE}.jsonl`);
    const archiveFile = path.join(archived, `rollout-2026-08-10T10-00-00-${UUID_ARCHIVE}.jsonl`);
    fs.writeFileSync(activeFile, activeContent);
    fs.writeFileSync(archiveFile, archiveContent);

    const shadow = await buildCodexShadow({
      activeRoot: sessions,
      archiveRoot: archived,
      nowMs: NOW_MS,
      maxBytesPerScan: 1
    });

    const dayA = localDayKey(EVENTS.A.ts);
    const dayB = localDayKey(EVENTS.B.ts);
    const dayOld = localDayKey(EVENTS.OLD.ts);

    assert.deepEqual(shadow.usageDaily, {
      [`codex:${dayA}`]: { input: 10, cached: 1, output: 2, total: 16 },
      [`codex:${dayB}`]: { input: 50, cached: 5, output: 7, total: 71 },
      [`codex:${dayOld}`]: { input: 40, cached: 4, output: 5, total: 55 }
    });

    assert.equal(shadow.summary.duplicates, 2);
    assert.equal(shadow.summary.records, 4);
    assert.equal(shadow.summary.daysRebuilt, 3);
    assert.ok(shadow.summary.passes > 1, 'small byte budget should force several passes');
    assert.ok(shadow.summary.bytesRead > 0);

    // The older-than-retention date must still be present; rebuild ignores historyDays.
    assert.ok(shadow.usageDaily[`codex:${dayOld}`]);

    // Final cursors point to EOF for both identities.
    assert.equal(shadow.cursors[UUID_ACTIVE].offset, Buffer.byteLength(activeContent));
    assert.equal(shadow.cursors[UUID_ARCHIVE].offset, Buffer.byteLength(archiveContent));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Step 2: static idempotence.
// ---------------------------------------------------------------------------

test('buildCodexShadow is deterministic across two fresh runs', async () => {
  const { base, sessions, archived } = makeTempRoots();
  try {
    fs.writeFileSync(path.join(sessions, `rollout-${UUID_ACTIVE}.jsonl`),
      usageLine(EVENTS.A) + usageLine(EVENTS.B));
    fs.writeFileSync(path.join(archived, `rollout-${UUID_ARCHIVE}.jsonl`),
      usageLine(EVENTS.C));

    const options = { activeRoot: sessions, archiveRoot: archived, nowMs: NOW_MS, maxBytesPerScan: 1 };
    const first = await buildCodexShadow(options);
    const second = await buildCodexShadow(options);

    assert.deepEqual(first, second);
    // No timing field should be added to the summary.
    assert.deepEqual(
      Object.keys(first.summary).sort(),
      ['bytesRead', 'daysRebuilt', 'duplicates', 'earliestDate', 'passes', 'records']
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Step 3: Codex-only snapshot replacement.
// ---------------------------------------------------------------------------

function makeCloneStore(seed) {
  let backing = JSON.parse(JSON.stringify(seed));
  let writes = 0;
  return {
    get writes() { return writes; },
    get backing() { return backing; },
    get store() { return JSON.parse(JSON.stringify(backing)); },
    set store(value) {
      writes += 1;
      backing = JSON.parse(JSON.stringify(value));
    }
  };
}

test('replaceCodexSnapshot swaps only codex rows in a single store assignment', () => {
  assert.equal(CODEX_ARCHIVE_MIGRATION_KEY, 'localLogMigrations.codexArchiveUuidCursorV1');

  const legacyCursor = { '/legacy/path/rollout-1.jsonl': { offset: 500 } };
  const kimiCursor = { '/kimi/path.jsonl': { offset: 12 } };
  const seed = {
    usageDaily: {
      'codex:2026-08-09': { input: 1, cached: 2, output: 3, total: 6 },
      'codex:2026-08-10': { input: 9, cached: 8, output: 7, total: 24 },
      'deepseek:2026-08-09': { input: 100, cached: 0, output: 0, total: 100, models: [] },
      'kimi:2026-08-09': { input: 50, cached: 0, output: 0, total: 50 }
    },
    localLogCursors: { codex: legacyCursor, kimi: kimiCursor },
    localLogMigrations: { kimiSomeMigration: true, codexArchiveUuidCursorV1: false },
    settings: { theme: 'dark' },
    providers: { deepseek: { apiKey: 'secret-api-key' }, kimi: { some: 'value' } },
    data: { historyDays: 7 }
  };

  const store = makeCloneStore(seed);
  const uuidCursor = {
    [UUID_ACTIVE]: {
      offset: 99,
      mtimeMs: 1,
      size: 99,
      headBytes: 0,
      headFingerprint: null,
      lastEventFingerprint: null
    }
  };
  const shadow = {
    usageDaily: {
      'codex:2026-08-11': { input: 11, cached: 12, output: 13, total: 36 },
      'codex:2026-08-12': { input: 21, cached: 22, output: 23, total: 66 }
    },
    cursors: uuidCursor,
    summary: { daysRebuilt: 2, earliestDate: '2026-08-11', passes: 1, records: 2, duplicates: 0, bytesRead: 123 }
  };

  replaceCodexSnapshot(store, shadow);

  assert.equal(store.writes, 1);

  const result = store.backing;
  assert.equal(result.usageDaily['codex:2026-08-09'], undefined);
  assert.equal(result.usageDaily['codex:2026-08-10'], undefined);
  assert.deepEqual(result.usageDaily, {
    'deepseek:2026-08-09': seed.usageDaily['deepseek:2026-08-09'],
    'kimi:2026-08-09': seed.usageDaily['kimi:2026-08-09'],
    'codex:2026-08-11': shadow.usageDaily['codex:2026-08-11'],
    'codex:2026-08-12': shadow.usageDaily['codex:2026-08-12']
  });
  assert.deepEqual(result.localLogCursors.codex, uuidCursor);
  assert.deepEqual(result.localLogCursors.kimi, kimiCursor);
  assert.equal(result.localLogMigrations.codexArchiveUuidCursorV1, true);
  assert.equal(result.localLogMigrations.kimiSomeMigration, true);
  assert.deepEqual(result.settings, { theme: 'dark' });
  assert.deepEqual(result.providers.deepseek, { apiKey: 'secret-api-key' });
  assert.deepEqual(result.providers.kimi, { some: 'value' });
  assert.deepEqual(result.data, { historyDays: 7 });
});

// ---------------------------------------------------------------------------
// Step 4: scan/commit failure behavior.
// ---------------------------------------------------------------------------

function makeThrowingStore(seed) {
  const backing = JSON.parse(JSON.stringify(seed));
  const original = JSON.parse(JSON.stringify(seed));
  return {
    backing,
    original,
    get store() { return backing; },
    set store(value) { throw new Error('commit exploded'); }
  };
}

test('a failing scan never invokes the store setter', async () => {
  const seed = { usageDaily: { 'deepseek:2026-08-09': { input: 1, cached: 0, output: 0, total: 1 } } };
  const store = makeCloneStore(seed);
  let calls = 0;
  const scanBatch = async () => {
    calls += 1;
    if (calls === 1) return { records: [], complete: false, bytesRead: 10 };
    throw new Error('scan exploded');
  };

  await assert.rejects(
    rebuildCodexUsage({ store, activeRoot: '/a', archiveRoot: '/b', nowMs: NOW_MS, maxPasses: 100, scanBatch }),
    /scan exploded/
  );

  assert.equal(store.writes, 0);
  assert.deepEqual(store.backing, seed);
});

test('a throwing store setter leaves the original snapshot untouched', async () => {
  const { base, sessions, archived } = makeTempRoots();
  try {
    fs.writeFileSync(path.join(sessions, `rollout-${UUID_ACTIVE}.jsonl`), usageLine(EVENTS.A));

    const seed = { usageDaily: { 'deepseek:2026-08-09': { input: 1, cached: 0, output: 0, total: 1 } } };
    const store = makeThrowingStore(seed);

    await assert.rejects(
      rebuildCodexUsage({ store, activeRoot: sessions, archiveRoot: archived, nowMs: NOW_MS, maxBytesPerScan: 4096 }),
      /commit exploded/
    );

    assert.deepEqual(store.backing, store.original);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('rebuild failure message leaks no rollout content or private path', async () => {
  const { base, sessions, archived } = makeTempRoots();
  try {
    const secretMarker = 987654321;
    fs.writeFileSync(path.join(sessions, `rollout-${UUID_ACTIVE}.jsonl`),
      usageLine({ ts: EVENTS.A.ts, input: 1, total: secretMarker }));

    const store = makeThrowingStore({ usageDaily: {} });

    await assert.rejects(
      rebuildCodexUsage({ store, activeRoot: sessions, archiveRoot: archived, nowMs: NOW_MS, maxBytesPerScan: 4096 }),
      (error) => {
        assert.ok(!error.message.includes(String(secretMarker)), 'must not leak rollout content');
        assert.ok(!error.message.includes(base), 'must not leak the full private path');
        return true;
      }
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('buildCodexShadow throws LOCAL_LOG_RESCAN_INCOMPLETE with safe counters when exhausted', async () => {
  const scanBatch = async () => ({ records: [], complete: false, bytesRead: 7 });

  await assert.rejects(
    buildCodexShadow({ activeRoot: '/a', archiveRoot: '/b', nowMs: NOW_MS, maxPasses: 2, scanBatch }),
    (error) => {
      assert.equal(error.code, 'LOCAL_LOG_RESCAN_INCOMPLETE');
      assert.equal(error.passes, 2);
      assert.equal(error.bytesRead, 14);
      assert.ok(!error.message.includes('/a'));
      assert.ok(!error.message.includes('/b'));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Task 7: read-only local acceptance verifier.
// ---------------------------------------------------------------------------

function makeHostileStoreProjection(usageDaily) {
  const projection = { usageDaily };
  Object.defineProperty(projection, 'store', {
    enumerable: false,
    set() { throw new Error('STORE_MUTATION'); }
  });
  projection.set = () => { throw new Error('STORE_MUTATION'); };
  projection.delete = () => { throw new Error('STORE_MUTATION'); };
  return projection;
}

test('verifyCodexArchiveUsage is read-only and returns exact totals', async () => {
  const { base, sessions, archived } = makeTempRoots();
  try {
    fs.writeFileSync(path.join(sessions, `rollout-${UUID_ACTIVE}.jsonl`), usageLine(EVENTS.A));
    fs.writeFileSync(path.join(archived, `rollout-${UUID_ARCHIVE}.jsonl`),
      usageLine(EVENTS.B) + usageLine(EVENTS.C));

    const dayA = localDayKey(EVENTS.A.ts);
    const dayB = localDayKey(EVENTS.B.ts);
    const hostile = makeHostileStoreProjection({
      [`codex:${dayA}`]: { total: 16 },
      [`codex:${dayB}`]: { total: 71 }
    });

    const result = await verifyCodexArchiveUsage({
      activeRoot: sessions,
      archiveRoot: archived,
      nowMs: NOW_MS,
      storeProjection: hostile
    });

    assert.equal(result.files, 2);
    assert.equal(result.uniqueEvents, 3);
    assert.equal(result.duplicateEvents, 0);
    assert.equal(result.daily[`codex:${dayA}`].total, 16);
    assert.equal(result.daily[`codex:${dayB}`].total, 71);

    assert.equal(result.comparedStoreDaily[dayA].match, true);
    assert.equal(result.comparedStoreDaily[dayB].match, true);
    assert.equal(result.comparedStoreDaily[dayB].total, 71);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('verifyCodexArchiveUsage flags mismatch without mutating the projection', async () => {
  const { base, sessions, archived } = makeTempRoots();
  try {
    fs.writeFileSync(path.join(sessions, `rollout-${UUID_ACTIVE}.jsonl`), usageLine(EVENTS.A));

    const dayA = localDayKey(EVENTS.A.ts);
    const hostile = makeHostileStoreProjection({ [`codex:${dayA}`]: { total: 999 } });

    const result = await verifyCodexArchiveUsage({
      activeRoot: sessions,
      archiveRoot: archived,
      nowMs: NOW_MS,
      storeProjection: hostile,
      date: dayA
    });

    assert.equal(result.comparedStoreDaily[dayA].match, false);
    assert.equal(result.comparedStoreDaily[dayA].total, 16);
    assert.equal(result.comparedStoreDaily[dayA].storeTotal, 999);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('verifyCodexArchiveUsage reports physical rollout files when one identity exists in both roots', async () => {
  const { base, sessions, archived } = makeTempRoots();
  try {
    const name = `rollout-${UUID_ACTIVE}.jsonl`;
    const line = usageLine(EVENTS.A);
    fs.writeFileSync(path.join(sessions, name), line);
    fs.writeFileSync(path.join(archived, name), line);

    const result = await verifyCodexArchiveUsage({
      activeRoot: sessions,
      archiveRoot: archived,
      nowMs: NOW_MS
    });

    assert.equal(result.files, 2);
    assert.equal(result.uniqueEvents, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('readStoreProjection rejects the live encrypted config before reading it', () => {
  assert.throws(
    () => readStoreProjection(liveStoreConfigPath()),
    (error) => error && error.code === 'LIVE_STORE_PROJECTION_FORBIDDEN'
  );
});

test('readStoreProjection never reads an encryption key', () => {
  assert.throws(
    () => readStoreProjection(path.join(os.tmpdir(), '.key')),
    (error) => error && error.code === 'STORE_PROJECTION_KEY_FORBIDDEN'
  );
});
