// Task 5: Codex usage runtime coordinator tests.
// 单一 FIFO 写队列、启动影子迁移、失败兼容回退、提交后补扫失败保持 ready。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCodexUsageRuntime,
  safeErrorCode
} = require('../src/main/providers/codex/runtime');
const { CODEX_ARCHIVE_MIGRATION_KEY } = require('../src/main/providers/codex/rebuild');

const FALLBACK_CODE = 'CODEX_ARCHIVE_MIGRATION_FAILED';

function getPath(object, key) {
  return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
}

function setPath(object, key, value) {
  const parts = key.split('.');
  let current = object;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[0]] = value;
}

function makeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    data,
    get(key) { return getPath(data, key); },
    set(key, value) { setPath(data, key, value); }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeSummary(overrides = {}) {
  return Object.assign({
    daysRebuilt: 1,
    earliestDate: '2026-08-01',
    passes: 1,
    records: 1,
    duplicates: 0,
    bytesRead: 10
  }, overrides);
}

// ---------------------------------------------------------------------------
// Step 1: unique-migration Promise.
// ---------------------------------------------------------------------------

test('startMigration returns a unique shared Promise and runs rebuild once', async () => {
  const store = makeStore({
    usageDaily: { 'codex:2026-08-01': { input: 1, cached: 0, output: 1, total: 2 } }
  });
  const gate = deferred();
  const summary = makeSummary();
  let rebuildCalls = 0;
  const rebuild = async () => {
    await gate.promise;
    rebuildCalls += 1;
    return summary;
  };

  const runtime = createCodexUsageRuntime({
    store,
    rebuildCodexUsage: rebuild,
    incrementalScan: async () => ({ records: [], complete: true, bytesRead: 0 })
  });

  const first = runtime.startMigration();
  const second = runtime.startMigration();
  assert.strictEqual(first, second, 'repeated calls must share one Promise');

  await tick();
  assert.equal(rebuildCalls, 0, 'rebuild must wait for the deferred gate');

  gate.resolve();
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(rebuildCalls, 1, 'rebuild must run exactly once');
  assert.strictEqual(r1, r2, 'both calls resolve to the same result object');
  assert.equal(r1.migrated, true);
  assert.equal(r1.skipped, false);
  assert.deepEqual(r1.summary, summary);
  assert.equal(runtime.getStatus().phase, 'ready');
  assert.equal(runtime.getStatus().migrationPending, false);
});

test('a committed migration marker short-circuits startup synchronously', async () => {
  const store = makeStore({ localLogMigrations: { codexArchiveUuidCursorV1: true } });
  let rebuildCalls = 0;
  const rebuild = async () => { rebuildCalls += 1; return makeSummary(); };

  const runtime = createCodexUsageRuntime({
    store,
    rebuildCodexUsage: rebuild,
    incrementalScan: async () => ({ records: [], complete: true })
  });

  assert.equal(runtime.getStatus().phase, 'ready', 'phase becomes ready synchronously');
  assert.equal(runtime.getStatus().migrationPending, false);
  assert.equal(runtime.getStatus().compatibilityMode, false);

  const result = await runtime.startMigration();
  assert.equal(rebuildCalls, 0, 'rebuild must be skipped when already migrated');
  assert.equal(result.migrated, true);
  assert.equal(result.skipped, true);
  assert.equal(runtime.getStatus().phase, 'ready');
});

// ---------------------------------------------------------------------------
// Step 2: pause/serialization.
// ---------------------------------------------------------------------------

test('migration pauses incremental writes, then resumes FIFO in UUID mode', async () => {
  const store = makeStore({
    usageDaily: { 'codex:2026-08-01': { input: 5, cached: 1, output: 2, total: 8 } }
  });
  const gate = deferred();
  const summary = makeSummary();
  let rebuildCalls = 0;
  const rebuild = async () => {
    await gate.promise;
    rebuildCalls += 1;
    store.set(CODEX_ARCHIVE_MIGRATION_KEY, true);
    return summary;
  };

  const runtime = createCodexUsageRuntime({
    store,
    rebuildCodexUsage: rebuild,
    incrementalScan: async () => ({ records: [], complete: true, bytesRead: 0 })
  });

  const migration = runtime.startMigration();

  const order = [];
  const modes = [];
  const inc1 = runtime.runIncremental(async (opts) => {
    order.push(1);
    modes.push(opts);
    await tick();
  });
  const inc2 = runtime.runIncremental(async (opts) => {
    order.push(2);
    modes.push(opts);
    await tick();
  });

  await tick();
  await tick();
  assert.deepEqual(order, [], 'incrementals must wait while migration is active');
  assert.equal(
    store.get('usageDaily')['codex:2026-08-01'].total,
    8,
    'old codex value remains readable during migration'
  );

  gate.resolve();
  await Promise.all([migration, inc1, inc2]);

  assert.equal(rebuildCalls, 1);
  assert.deepEqual(order, [1, 2], 'incrementals run FIFO');
  assert.deepEqual(modes, [{ mode: 'uuid' }, { mode: 'uuid' }]);
  assert.equal(runtime.getStatus().phase, 'ready');
});

test('failed migration resumes queued incrementals in legacy mode chosen at start', async () => {
  const store = makeStore({
    usageDaily: { 'codex:2026-08-01': { input: 5, cached: 1, output: 2, total: 8 } }
  });
  const gate = deferred();
  const failure = Object.assign(new Error('scan failed'), { code: 'LOCAL_LOG_RESCAN_INCOMPLETE' });
  let rebuildCalls = 0;
  const rebuild = async () => {
    await gate.promise;
    rebuildCalls += 1;
    throw failure;
  };

  const runtime = createCodexUsageRuntime({
    store,
    rebuildCodexUsage: rebuild,
    incrementalScan: async () => ({ records: [], complete: true })
  });

  const migration = runtime.startMigration();

  const modes = [];
  const inc1 = runtime.runIncremental(async (opts) => { modes.push(opts); });
  const inc2 = runtime.runIncremental(async (opts) => { modes.push(opts); });

  await tick();
  gate.resolve();
  const result = await migration;
  await Promise.all([inc1, inc2]);

  assert.equal(result.migrated, false);
  assert.equal(result.errorCode, 'LOCAL_LOG_RESCAN_INCOMPLETE');
  assert.deepEqual(modes, [{ mode: 'legacy' }, { mode: 'legacy' }]);
  assert.equal(runtime.getStatus().phase, 'compatibility');
  assert.equal(runtime.getStatus().compatibilityMode, true);
});

test('manual rebuild and incremental serialize to one active Codex writer', async () => {
  const store = makeStore({ localLogMigrations: { codexArchiveUuidCursorV1: true } });
  let active = 0;
  let maxActive = 0;
  function enter() {
    active += 1;
    maxActive = Math.max(maxActive, active);
  }
  function leave() {
    active -= 1;
  }
  const summary = makeSummary();
  const rebuild = async () => {
    enter();
    try {
      await tick();
      store.set(CODEX_ARCHIVE_MIGRATION_KEY, true);
      return summary;
    } finally {
      leave();
    }
  };
  const incrementalScan = async () => {
    enter();
    try {
      await tick();
      return { records: [], complete: true, bytesRead: 0 };
    } finally {
      leave();
    }
  };

  const runtime = createCodexUsageRuntime({ store, rebuildCodexUsage: rebuild, incrementalScan });

  const rb = runtime.rebuild();
  const inc = runtime.runIncremental(async (opts) => {
    enter();
    try {
      await tick();
      return { records: [], complete: true };
    } finally {
      leave();
    }
  });

  await Promise.all([rb, inc]);
  assert.equal(maxActive, 1, 'at most one Codex writer may be active');
  assert.equal(runtime.getStatus().phase, 'ready');
});

// ---------------------------------------------------------------------------
// Step 3: compatibility fallback.
// ---------------------------------------------------------------------------

test('startup migration failure enters compatibility and falls back to legacy', async () => {
  const store = makeStore({
    usageDaily: { 'codex:2026-08-01': { input: 1, cached: 0, output: 1, total: 2 } }
  });
  let rebuildCalls = 0;
  const rebuild = async () => {
    rebuildCalls += 1;
    throw Object.assign(new Error('shadow scan exploded'), { code: 'LOCAL_LOG_RESCAN_INCOMPLETE' });
  };

  const runtime = createCodexUsageRuntime({
    store,
    rebuildCodexUsage: rebuild,
    incrementalScan: async () => ({ records: [], complete: true })
  });

  const result = await runtime.startMigration();
  assert.equal(result.migrated, false);
  assert.equal(result.errorCode, 'LOCAL_LOG_RESCAN_INCOMPLETE');
  assert.equal(runtime.getStatus().phase, 'compatibility');
  assert.equal(runtime.getStatus().compatibilityMode, true);
  assert.equal(store.get(CODEX_ARCHIVE_MIGRATION_KEY), undefined, 'marker stays missing');

  const modes = [];
  await runtime.runIncremental(async (opts) => {
    modes.push(opts);
    return { records: [], complete: true };
  });
  assert.deepEqual(modes, [{ mode: 'legacy' }], 'runtime supplies legacy mode after failure');

  const second = createCodexUsageRuntime({
    store,
    rebuildCodexUsage: rebuild,
    incrementalScan: async () => ({ records: [], complete: true })
  });
  await second.startMigration();
  assert.equal(rebuildCalls, 2, 'a fresh runtime on the next launch retries migration');
});

test('manual retry after compatibility failure commits and moves to ready', async () => {
  const store = makeStore({ usageDaily: {} });
  let shouldFail = true;
  let rebuildCalls = 0;
  const catchUpModes = [];
  const rebuild = async () => {
    rebuildCalls += 1;
    if (shouldFail) {
      throw Object.assign(new Error('commit exploded'), { code: 'STORE_COMMIT_FAILED' });
    }
    store.set(CODEX_ARCHIVE_MIGRATION_KEY, true);
    return makeSummary();
  };
  const incrementalScan = async (opts) => {
    catchUpModes.push(opts && opts.mode);
    return { records: [], complete: true, bytesRead: 0 };
  };

  const runtime = createCodexUsageRuntime({ store, rebuildCodexUsage: rebuild, incrementalScan });

  const first = await runtime.startMigration();
  assert.equal(first.migrated, false);
  assert.equal(runtime.getStatus().phase, 'compatibility');

  shouldFail = false;
  const summary = await runtime.rebuild();
  assert.equal(summary.daysRebuilt, 1);
  assert.equal(store.get(CODEX_ARCHIVE_MIGRATION_KEY), true, 'successful retry commits the marker');
  assert.deepEqual(catchUpModes, ['uuid'], 'one UUID catch-up after retry');
  assert.equal(runtime.getStatus().phase, 'ready');
  assert.equal(runtime.getStatus().compatibilityMode, false);
});

test('manual retry failure keeps compatibility and propagates a safe error', async () => {
  const store = makeStore({ usageDaily: {} });
  let incrementalCalls = 0;
  const rebuild = async () => {
    // 无 code 且 message 含私密路径:必须被映射为安全码且不外泄。
    throw new Error('raw private path /home/user/secret leaked');
  };

  const runtime = createCodexUsageRuntime({
    store,
    rebuildCodexUsage: rebuild,
    incrementalScan: async () => { incrementalCalls += 1; return { records: [], complete: true }; }
  });

  await runtime.startMigration();
  assert.equal(runtime.getStatus().phase, 'compatibility');
  assert.equal(runtime.getStatus().lastErrorCode, FALLBACK_CODE);

  await assert.rejects(runtime.rebuild(), (error) => {
    assert.equal(error.code, FALLBACK_CODE);
    assert.ok(!/raw private|secret|leaked|\/home/.test(error.message), 'must not leak raw message');
    return true;
  });
  assert.equal(runtime.getStatus().phase, 'compatibility');
  assert.equal(runtime.getStatus().compatibilityMode, true);
  assert.equal(store.get(CODEX_ARCHIVE_MIGRATION_KEY), undefined, 'marker remains absent');
  assert.equal(incrementalCalls, 0, 'pre-commit failure never runs catch-up');
});

test('manual rebuild failure after a committed migration remains ready in UUID mode', async () => {
  const store = makeStore({ localLogMigrations: { codexArchiveUuidCursorV1: true } });
  const runtime = createCodexUsageRuntime({
    store,
    rebuildCodexUsage: async () => {
      throw Object.assign(new Error('temporary read failure'), { code: 'EIO' });
    },
    incrementalScan: async () => ({ records: [], complete: true })
  });

  await assert.rejects(runtime.rebuild(), (error) => error && error.code === 'EIO');
  assert.equal(runtime.getStatus().phase, 'ready');
  assert.equal(runtime.getStatus().compatibilityMode, false);

  const modes = [];
  await runtime.runIncremental(async (options) => { modes.push(options.mode); });
  assert.deepEqual(modes, ['uuid']);
});

// ---------------------------------------------------------------------------
// Step 4: successful post-commit catch-up.
// ---------------------------------------------------------------------------

test('successful migration runs exactly one UUID catch-up after commit', async () => {
  const store = makeStore({ usageDaily: {} });
  const events = [];
  let rebuildCalls = 0;
  let incrementalCalls = 0;
  const summary = makeSummary();
  const rebuild = async () => {
    rebuildCalls += 1;
    store.set(CODEX_ARCHIVE_MIGRATION_KEY, true);
    events.push('rebuild');
    return summary;
  };
  const incrementalScan = async (opts) => {
    incrementalCalls += 1;
    events.push(
      'catch-up:' + (store.get(CODEX_ARCHIVE_MIGRATION_KEY) === true ? 'committed' : 'uncommitted')
    );
    return { records: [], complete: true, bytesRead: 0 };
  };

  const runtime = createCodexUsageRuntime({
    store,
    rebuildCodexUsage: rebuild,
    incrementalScan,
    onCatchUpComplete: async () => { events.push('refresh'); }
  });

  const result = await runtime.startMigration();
  assert.equal(rebuildCalls, 1);
  assert.equal(incrementalCalls, 1, 'exactly one UUID catch-up');
  assert.equal(result.migrated, true);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.summary, summary);
  assert.deepEqual(
    events,
    ['rebuild', 'catch-up:committed', 'refresh'],
    'dashboard refresh runs only after the committed catch-up'
  );
  assert.equal(runtime.getStatus().phase, 'ready');
});

test('post-commit catch-up failure keeps ready and never falls back to legacy', async () => {
  const store = makeStore({ usageDaily: {} });
  const summary = makeSummary();
  let refreshCalls = 0;
  const rebuild = async () => {
    store.set(CODEX_ARCHIVE_MIGRATION_KEY, true);
    return summary;
  };
  const incrementalScan = async () => {
    throw Object.assign(new Error('tail read failed'), { code: 'TAIL_READ_FAILED' });
  };

  const runtime = createCodexUsageRuntime({
    store,
    rebuildCodexUsage: rebuild,
    incrementalScan,
    onCatchUpComplete: async () => { refreshCalls += 1; }
  });

  const result = await runtime.startMigration();
  assert.equal(result.migrated, true);
  assert.equal(result.catchUpErrorCode, 'TAIL_READ_FAILED');
  assert.deepEqual(result.summary, summary);
  assert.equal(runtime.getStatus().phase, 'ready', 'never enters compatibility/legacy mode');
  assert.equal(runtime.getStatus().compatibilityMode, false);
  assert.equal(refreshCalls, 1, 'committed snapshot is broadcast even when catch-up fails');

  const modes = [];
  await runtime.runIncremental(async (opts) => {
    modes.push(opts);
    return { records: [], complete: true };
  });
  assert.deepEqual(modes, [{ mode: 'uuid' }], 'later scans retry the committed cursor in UUID mode');
  assert.equal(store.get(CODEX_ARCHIVE_MIGRATION_KEY), true);
});

// ---------------------------------------------------------------------------
// Error mapping.
// ---------------------------------------------------------------------------

test('safeErrorCode maps invalid codes to the safe fallback', () => {
  assert.equal(
    safeErrorCode(Object.assign(new Error('x'), { code: 'LOCAL_LOG_RESCAN_INCOMPLETE' })),
    'LOCAL_LOG_RESCAN_INCOMPLETE'
  );
  assert.equal(
    safeErrorCode(Object.assign(new Error('x'), { code: 'ok-but-lowercase' })),
    FALLBACK_CODE
  );
  assert.equal(
    safeErrorCode(Object.assign(new Error('x'), { code: 'BAD CODE' })),
    FALLBACK_CODE
  );
  assert.equal(safeErrorCode(new Error('no code')), FALLBACK_CODE);
  assert.equal(safeErrorCode(null), FALLBACK_CODE);
});
