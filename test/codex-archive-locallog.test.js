const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  rolloutIdentity,
  codexEventFingerprint,
  parseRolloutLine,
  resolveCodexLogRoots,
  readLocalLog,
  scanCodexLogBatch,
  DEFAULT_ROOT,
  DEFAULT_ARCHIVE_ROOT
} = require('../src/main/providers/codex/locallog');

// Step 1: rollout identity.
test('rolloutIdentity extracts the terminal UUID independent of path', () => {
  const name = 'rollout-2026-08-09T19-01-47-019fe62f-9a3c-7cb2-9e34-f21173cf257d.jsonl';
  assert.equal(rolloutIdentity('C:\\a\\' + name), '019fe62f-9a3c-7cb2-9e34-f21173cf257d');
  assert.equal(rolloutIdentity('/b/' + name), '019fe62f-9a3c-7cb2-9e34-f21173cf257d');
});

test('rolloutIdentity falls back to basename for nonstandard rollouts', () => {
  assert.equal(rolloutIdentity('/a/rollout-private-fixture.jsonl'), 'rollout-private-fixture.jsonl');
});

// Step 2: event fingerprints.
function tokenLine({ ts, input, cached, output, reasoning, total, rateLimits, totalUsage }) {
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
        },
        total_token_usage: totalUsage
      },
      rate_limits: rateLimits
    },
    timestamp: ts
  });
}

test('parseRolloutLine attaches a stable sha256 eventFingerprint', () => {
  const ts = '2026-08-02T13:17:43.794Z';
  const a = parseRolloutLine(tokenLine({ ts, input: 10, cached: 5, output: 2, reasoning: 1, total: 12 }));
  const b = parseRolloutLine(tokenLine({ ts, input: 10, cached: 5, output: 2, reasoning: 1, total: 12 }));
  assert.ok(a && b);
  assert.equal(typeof a.eventFingerprint, 'string');
  assert.ok(a.eventFingerprint.startsWith('sha256:'));
  assert.equal(a.eventFingerprint, b.eventFingerprint);
});

test('eventFingerprint ignores rate_limits and total_token_usage snapshots', () => {
  const ts = '2026-08-02T13:17:43.794Z';
  const a = parseRolloutLine(tokenLine({
    ts,
    input: 10, cached: 5, output: 2, reasoning: 1, total: 12,
    rateLimits: { limit_id: 'codex_a', primary: { used_percent: 0.1 } },
    totalUsage: { input_tokens: 776072987, total_tokens: 777969188 }
  }));
  const b = parseRolloutLine(tokenLine({
    ts,
    input: 10, cached: 5, output: 2, reasoning: 1, total: 12,
    rateLimits: { limit_id: 'codex_b', primary: { used_percent: 99.9 } },
    totalUsage: { input_tokens: 1, total_tokens: 2 }
  }));
  assert.ok(a && b);
  assert.equal(a.eventFingerprint, b.eventFingerprint);
});

test('eventFingerprint changes when output_tokens changes by one', () => {
  const ts = '2026-08-02T13:17:43.794Z';
  const a = parseRolloutLine(tokenLine({ ts, input: 10, cached: 5, output: 2, reasoning: 1, total: 12 }));
  const b = parseRolloutLine(tokenLine({ ts, input: 10, cached: 5, output: 3, reasoning: 1, total: 13 }));
  assert.ok(a && b);
  assert.notEqual(a.eventFingerprint, b.eventFingerprint);
});

test('codexEventFingerprint normalizes absent numeric fields to zero', () => {
  const ts = 1784179063794;
  const full = codexEventFingerprint({ ts, input: 10, cached: 0, output: 0, reasoning: 0, total: 0 });
  const sparse = codexEventFingerprint({ ts, input: 10 });
  assert.equal(full, sparse);
});

test('codexEventFingerprint returns null when it cannot be computed', () => {
  assert.equal(codexEventFingerprint(null), null);
  assert.equal(codexEventFingerprint({}), null);
  assert.equal(codexEventFingerprint({ ts: 'not-a-date' }), null);
});

test('parseRolloutLine returns null for malformed or non-usage lines', () => {
  assert.equal(parseRolloutLine('not json'), null);
  assert.equal(parseRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'other' } })), null);
  assert.equal(parseRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } })), null);
  assert.equal(parseRolloutLine(''), null);
});

// Step 3: root resolution.
function makeStore(values) {
  const data = values || {};
  return { get(k) { return data[k]; } };
}

test('resolveCodexLogRoots uses defaults when no custom setting exists', () => {
  const roots = resolveCodexLogRoots(makeStore());
  assert.deepEqual(roots, { activeRoot: DEFAULT_ROOT(), archiveRoot: DEFAULT_ARCHIVE_ROOT() });
});

test('resolveCodexLogRoots uses custom active only with null archive', () => {
  const roots = resolveCodexLogRoots(makeStore({ 'providers.codex.localLogRoot': '/custom/active' }));
  assert.deepEqual(roots, { activeRoot: '/custom/active', archiveRoot: null });
});

test('resolveCodexLogRoots uses both custom paths when both are set', () => {
  const roots = resolveCodexLogRoots(makeStore({
    'providers.codex.localLogRoot': '/custom/active',
    'providers.codex.archivedLogRoot': '/custom/archive'
  }));
  assert.deepEqual(roots, { activeRoot: '/custom/active', archiveRoot: '/custom/archive' });
});

test('resolveCodexLogRoots keeps default active with explicit custom archive', () => {
  const roots = resolveCodexLogRoots(makeStore({ 'providers.codex.archivedLogRoot': '/custom/archive' }));
  assert.deepEqual(roots, { activeRoot: DEFAULT_ROOT(), archiveRoot: '/custom/archive' });
});

// ---------------------------------------------------------------------------
// Dual-root UUID cursor scanner (Task 3).
// ---------------------------------------------------------------------------

const TEST_UUID = '019fe62f-9a3c-7cb2-9e34-f21173cf257d';
const TEST_UUID_SECOND = '019fe62f-9a3c-7cb2-9e34-f21173cf257e';

function makeTempRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-archive-locallog-'));
  const sessions = path.join(base, 'sessions');
  const archived = path.join(base, 'archived_sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });
  return { base, sessions, archived };
}

function makeMutableStore(values) {
  const data = Object.assign({}, values);
  return {
    data,
    get(key) { return data[key]; },
    set(key, value) { data[key] = value; }
  };
}

function usageLine({ ts, input = 0, cached = 0, output = 0, reasoning = 0, total = 0 }) {
  return tokenLine({ ts, input, cached, output, reasoning, total }) + '\n';
}

function uuidCodexStore(sessions, archived, extra) {
  return makeMutableStore(Object.assign({
    'providers.codex.localLogRoot': sessions,
    'providers.codex.archivedLogRoot': archived
  }, extra || {}));
}

// Step 1: move regression.
test('scanCodexLogBatch follows a rollout moved into the archive without replaying', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-2026-08-09T19-01-47-${TEST_UUID}.jsonl`;
  const sourceFile = path.join(sessions, '2026', '08', '09', name);
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });

  const line1 = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 });
  const line2 = usageLine({ ts: '2026-08-09T11:00:00.000Z', input: 20, total: 20 });
  fs.writeFileSync(sourceFile, line1 + line2);

  const store = uuidCodexStore(sessions, archived);
  const now = Date.now();

  try {
    const first = await scanCodexLogBatch({
      store,
      mode: 'uuid',
      diagnostics: {},
      nowMs: now,
      chunkBytes: 4096,
      maxBytesPerScan: Buffer.byteLength(line1)
    });
    assert.deepEqual(first.records.map((r) => r.usage.total), [10]);
    assert.equal(first.complete, false);

    const archiveFile = path.join(archived, '2026', '08', '09', name);
    fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
    fs.renameSync(sourceFile, archiveFile);

    const second = await scanCodexLogBatch({
      store,
      mode: 'uuid',
      diagnostics: {},
      nowMs: now,
      chunkBytes: 4096,
      maxBytesPerScan: 4096
    });
    assert.deepEqual(second.records.map((r) => r.usage.total), [20]);

    assert.deepEqual(Object.keys(store.get('localLogCursors.codex') || {}), [TEST_UUID]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Step 2: dual-candidate and selection.
test('a rollout present in both roots is scanned exactly once', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-${TEST_UUID}.jsonl`;
  const activeFile = path.join(sessions, name);
  const archiveFile = path.join(archived, name);
  const line = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 7, total: 7 });
  fs.writeFileSync(activeFile, line);
  fs.copyFileSync(activeFile, archiveFile);

  try {
    const store = uuidCodexStore(sessions, archived);
    const batch = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: Date.now() });
    assert.deepEqual(batch.records.map((r) => r.usage.total), [7]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('larger archive candidate that carries the offset is selected for the tail', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-${TEST_UUID}.jsonl`;
  const activeFile = path.join(sessions, name);
  const archiveFile = path.join(archived, name);

  const line1 = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 });
  const line2 = usageLine({ ts: '2026-08-09T11:00:00.000Z', input: 20, total: 20 });
  fs.writeFileSync(activeFile, line1);

  try {
    const store = uuidCodexStore(sessions, archived);
    const now = Date.now();
    const first = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: now });
    assert.deepEqual(first.records.map((r) => r.usage.total), [10]);

    fs.writeFileSync(archiveFile, line1 + line2);

    const second = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: now });
    assert.deepEqual(second.records.map((r) => r.usage.total), [20]);
    assert.deepEqual(Object.keys(store.get('localLogCursors.codex') || {}), [TEST_UUID]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('equal-size dual candidates deterministically select the active root', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-${TEST_UUID}.jsonl`;
  const activeLine = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 7, total: 7 });
  const archiveLine = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 9, total: 9 });
  assert.equal(Buffer.byteLength(activeLine), Buffer.byteLength(archiveLine));
  fs.writeFileSync(path.join(sessions, name), activeLine);
  fs.writeFileSync(path.join(archived, name), archiveLine);

  try {
    const store = uuidCodexStore(sessions, archived);
    const batch = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: Date.now() });
    assert.deepEqual(batch.records.map((r) => r.usage.total), [7]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a candidate too small to carry the cursor offset is excluded', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-${TEST_UUID}.jsonl`;
  const activeFile = path.join(sessions, name);
  const archiveFile = path.join(archived, name);

  const line1 = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 });
  const line2 = usageLine({ ts: '2026-08-09T11:00:00.000Z', input: 20, total: 20 });
  const line3 = usageLine({ ts: '2026-08-09T12:00:00.000Z', input: 30, total: 30 });
  fs.writeFileSync(activeFile, line1 + line2);

  try {
    const store = uuidCodexStore(sessions, archived);
    const now = Date.now();
    const first = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: now });
    assert.deepEqual(first.records.map((r) => r.usage.total), [10, 20]);

    // Active shrinks below the cursor offset; archive carries the offset plus a tail.
    fs.writeFileSync(activeFile, line1);
    fs.writeFileSync(archiveFile, line1 + line2 + line3);

    const second = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: now });
    assert.deepEqual(second.records.map((r) => r.usage.total), [30]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a head-conflicting larger candidate is skipped and counted diagnostically', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-${TEST_UUID}.jsonl`;
  const activeFile = path.join(sessions, name);
  const archiveFile = path.join(archived, name);

  const line1 = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 });
  const line2 = usageLine({ ts: '2026-08-09T11:00:00.000Z', input: 20, total: 20 });
  const line3 = usageLine({ ts: '2026-08-09T12:00:00.000Z', input: 30, total: 30 });
  const line4 = usageLine({ ts: '2026-08-09T13:00:00.000Z', input: 40, total: 40 });
  const line5 = usageLine({ ts: '2026-08-09T14:00:00.000Z', input: 50, total: 50 });
  fs.writeFileSync(activeFile, line1);

  try {
    const store = uuidCodexStore(sessions, archived);
    const now = Date.now();
    const first = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: now });
    assert.deepEqual(first.records.map((r) => r.usage.total), [10]);

    fs.appendFileSync(activeFile, line2);
    fs.writeFileSync(archiveFile, line3 + line4 + line5);

    const diagnostics = {};
    const second = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics, nowMs: now });
    assert.deepEqual(second.records.map((r) => r.usage.total), [20]);
    assert.equal(diagnostics.headConflict, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a cursor identity absent from both roots is removed only after enumeration', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const ghost = '11111111-2222-4333-8444-555555555555';
  const store = uuidCodexStore(sessions, archived, {
    'localLogCursors.codex': {
      [ghost]: {
        offset: 5,
        mtimeMs: Date.now(),
        size: 5,
        headBytes: 0,
        headFingerprint: null,
        lastEventFingerprint: null
      }
    }
  });

  try {
    const batch = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: Date.now() });
    assert.equal(batch.complete, true);
    assert.equal((store.get('localLogCursors.codex') || {})[ghost], undefined);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('cursor cleanup uses the union of both roots, not a single root', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-${TEST_UUID}.jsonl`;
  const archiveFile = path.join(archived, name);
  const line = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 5, total: 5 });
  fs.writeFileSync(archiveFile, line);

  const store = uuidCodexStore(sessions, archived, {
    'localLogCursors.codex': {
      [TEST_UUID]: {
        offset: 0,
        mtimeMs: 0,
        size: 0,
        headBytes: 0,
        headFingerprint: null,
        lastEventFingerprint: null
      }
    }
  });

  try {
    const batch = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: Date.now() });
    assert.deepEqual(batch.records.map((r) => r.usage.total), [5]);
    assert.ok((store.get('localLogCursors.codex') || {})[TEST_UUID]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Step 3: replacement and boundary dedupe.
test('replacing a rollout under the same UUID restarts scanning at zero', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-${TEST_UUID}.jsonl`;
  const file = path.join(sessions, name);

  const lineA = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 });
  const lineB = usageLine({ ts: '2026-08-09T11:00:00.000Z', input: 20, total: 20 });
  assert.equal(Buffer.byteLength(lineA), Buffer.byteLength(lineB));
  fs.writeFileSync(file, lineA);

  try {
    const store = uuidCodexStore(sessions, archived);
    const now = Date.now();
    const first = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: now });
    assert.deepEqual(first.records.map((r) => r.usage.total), [10]);

    fs.writeFileSync(file, lineB);

    const diagnostics = {};
    const second = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics, nowMs: now });
    assert.deepEqual(second.records.map((r) => r.usage.total), [20]);
    assert.equal(diagnostics.headConflict, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('appending past a short persisted prefix continues and expands headBytes', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-${TEST_UUID}.jsonl`;
  const file = path.join(sessions, name);

  const line1 = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 });
  fs.writeFileSync(file, line1);

  try {
    const store = uuidCodexStore(sessions, archived);
    const now = Date.now();
    await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: now });

    const cursor1 = store.get('localLogCursors.codex')[TEST_UUID];
    assert.ok(Buffer.byteLength(line1) < 4096);
    assert.equal(cursor1.headBytes, Buffer.byteLength(line1));

    const line2 = usageLine({ ts: '2026-08-09T11:00:00.000Z', input: 20, total: 20 });
    fs.appendFileSync(file, line2);

    const second = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: now });
    assert.deepEqual(second.records.map((r) => r.usage.total), [20]);

    const cursor2 = store.get('localLogCursors.codex')[TEST_UUID];
    assert.equal(cursor2.offset, Buffer.byteLength(line1 + line2));
    assert.equal(cursor2.headBytes, Buffer.byteLength(line1 + line2));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('adjacent duplicate events split across batches advance without re-emitting', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-${TEST_UUID}.jsonl`;
  const file = path.join(sessions, name);

  const lineA = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 });
  const lineB = usageLine({ ts: '2026-08-09T11:00:00.000Z', input: 20, total: 20 });
  fs.writeFileSync(file, lineA + lineA + lineB);

  try {
    const store = uuidCodexStore(sessions, archived);
    const now = Date.now();
    const first = await scanCodexLogBatch({
      store,
      mode: 'uuid',
      diagnostics: {},
      nowMs: now,
      chunkBytes: 4096,
      maxBytesPerScan: Buffer.byteLength(lineA)
    });
    assert.deepEqual(first.records.map((r) => r.usage.total), [10]);
    assert.equal(first.complete, false);

    const diagnostics = {};
    const second = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics, nowMs: now });
    assert.deepEqual(second.records.map((r) => r.usage.total), [20]);
    assert.ok(diagnostics.duplicateEvent >= 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('full rebuild with a global fingerprint set emits non-adjacent duplicates once', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-${TEST_UUID}.jsonl`;
  const file = path.join(sessions, name);

  const lineA = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 });
  const lineB = usageLine({ ts: '2026-08-09T11:00:00.000Z', input: 20, total: 20 });
  fs.writeFileSync(file, lineA + lineB + lineA);

  try {
    const now = Date.now();

    const rebuildDiagnostics = {};
    const rebuild = await scanCodexLogBatch({
      store: uuidCodexStore(sessions, archived),
      mode: 'uuid',
      diagnostics: rebuildDiagnostics,
      nowMs: now,
      seenFingerprints: new Set()
    });
    assert.deepEqual(rebuild.records.map((r) => r.usage.total), [10, 20]);
    assert.equal(rebuildDiagnostics.duplicateEvent, 1);

    const incremental = await scanCodexLogBatch({
      store: uuidCodexStore(sessions, archived),
      mode: 'uuid',
      diagnostics: {},
      nowMs: now
    });
    assert.deepEqual(incremental.records.map((r) => r.usage.total), [10, 20, 10]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Step 4: open-after-move retry.
test('moving a file before open recollects once without resetting the UUID cursor', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const name = `rollout-${TEST_UUID}.jsonl`;
  const activeFile = path.join(sessions, name);
  const archiveFile = path.join(archived, name);

  const line1 = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 });
  const line2 = usageLine({ ts: '2026-08-09T11:00:00.000Z', input: 20, total: 20 });
  fs.writeFileSync(activeFile, line1);

  try {
    const store = uuidCodexStore(sessions, archived);
    const now = Date.now();
    const first = await scanCodexLogBatch({ store, mode: 'uuid', diagnostics: {}, nowMs: now });
    assert.deepEqual(first.records.map((r) => r.usage.total), [10]);

    fs.appendFileSync(activeFile, line2);

    let hookCalls = 0;
    const second = await scanCodexLogBatch({
      store,
      mode: 'uuid',
      diagnostics: {},
      nowMs: now,
      openCandidate: async (candidate) => {
        hookCalls += 1;
        if (hookCalls === 1) {
          fs.renameSync(activeFile, archiveFile);
          const error = new Error('ENOENT');
          error.code = 'ENOENT';
          throw error;
        }
        return fs.promises.open(candidate.filePath, 'r');
      }
    });

    assert.deepEqual(second.records.map((r) => r.usage.total), [20]);
    assert.equal(hookCalls, 1);
    const cursor = store.get('localLogCursors.codex')[TEST_UUID];
    assert.ok(cursor);
    assert.equal(cursor.offset, Buffer.byteLength(line1 + line2));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a failed UUID batch publishes neither partial usage nor advanced cursors', async () => {
  const { base, sessions, archived } = makeTempRoots();
  const firstLine = usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 });
  const secondLine = usageLine({ ts: '2026-08-09T11:00:00.000Z', input: 20, total: 20 });
  fs.writeFileSync(path.join(sessions, `rollout-${TEST_UUID}.jsonl`), firstLine);
  fs.writeFileSync(path.join(sessions, `rollout-${TEST_UUID_SECOND}.jsonl`), secondLine);

  const store = uuidCodexStore(sessions, archived, {
    'localLogMigrations.codexArchiveUuidCursorV1': true,
    usageDaily: {}
  });

  try {
    await assert.rejects(
      readLocalLog({ store }, {
        mode: 'uuid',
        nowMs: Date.now(),
        openCandidate: async (candidate) => {
          if (candidate.identity === TEST_UUID_SECOND) {
            throw Object.assign(new Error('second rollout failed'), { code: 'EIO' });
          }
          return fs.promises.open(candidate.filePath, 'r');
        }
      }),
      (error) => error && error.code === 'EIO'
    );

    assert.deepEqual(store.get('usageDaily'), {});
    assert.equal(store.get('localLogCursors.codex'), undefined);

    const retry = await readLocalLog({ store }, { mode: 'uuid', nowMs: Date.now() });
    assert.deepEqual(retry.records.map((record) => record.usage.total), [10, 20]);
    assert.equal(store.get('usageDaily')['codex:2026-08-09'].total, 30);
    assert.deepEqual(Object.keys(store.get('localLogCursors.codex')), [TEST_UUID, TEST_UUID_SECOND]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a successful UUID read commits usage and cursors in one store snapshot', async () => {
  const { base, sessions, archived } = makeTempRoots();
  fs.writeFileSync(
    path.join(sessions, `rollout-${TEST_UUID}.jsonl`),
    usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 })
  );

  let snapshot = {
    providers: { codex: { localLogRoot: sessions, archivedLogRoot: archived } },
    localLogMigrations: { codexArchiveUuidCursorV1: true },
    usageDaily: {}
  };
  let snapshotAssignments = 0;
  let snapshotReads = 0;
  let pointWrites = 0;
  const store = {
    get(key) {
      return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), snapshot);
    },
    set() { pointWrites += 1; },
    get store() {
      snapshotReads += 1;
      return structuredClone(snapshot);
    },
    set store(value) {
      snapshotAssignments += 1;
      snapshot = structuredClone(value);
    }
  };

  try {
    const batch = await readLocalLog({ store }, { mode: 'uuid', nowMs: Date.now() });
    assert.deepEqual(batch.records.map((record) => record.usage.total), [10]);
    assert.equal(snapshotAssignments, 1);
    assert.equal(snapshotReads, 1);
    assert.equal(pointWrites, 0);
    assert.equal(snapshot.usageDaily['codex:2026-08-09'].total, 10);
    assert.ok(snapshot.localLogCursors.codex[TEST_UUID]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('UUID read restores usage when a compatibility store rejects the cursor write', async () => {
  const { base, sessions, archived } = makeTempRoots();
  fs.writeFileSync(
    path.join(sessions, `rollout-${TEST_UUID}.jsonl`),
    usageLine({ ts: '2026-08-09T10:00:00.000Z', input: 10, total: 10 })
  );
  const store = uuidCodexStore(sessions, archived, {
    usageDaily: { 'kimi:2026-08-09': { input: 1, cached: 0, output: 1, total: 2 } }
  });
  const originalSet = store.set.bind(store);
  store.set = (key, value) => {
    if (key === 'localLogCursors.codex') {
      throw Object.assign(new Error('cursor write failed'), { code: 'STORE_WRITE_FAILED' });
    }
    originalSet(key, value);
  };

  try {
    await assert.rejects(
      readLocalLog({ store }, { mode: 'uuid', nowMs: Date.now() }),
      (error) => error && error.code === 'STORE_WRITE_FAILED'
    );
    assert.deepEqual(store.get('usageDaily'), {
      'kimi:2026-08-09': { input: 1, cached: 0, output: 1, total: 2 }
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
