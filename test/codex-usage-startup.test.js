const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startCodexUsageBootstrap,
  CODEX_USAGE_BOOTSTRAP_FAILED
} = require('../src/main/core/codex-usage-bootstrap');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('bootstrap constructs runtime, starts migration, then constructs scheduler without awaiting', () => {
  const events = [];
  const migration = deferred();

  const fakeRuntime = {
    startMigration() {
      events.push('migration-started');
      return migration.promise;
    }
  };

  const bootstrap = startCodexUsageBootstrap({
    createRuntime() {
      events.push('runtime-created');
      return fakeRuntime;
    },
    startScheduler(runtime) {
      events.push('scheduler-created');
      assert.strictEqual(runtime, fakeRuntime);
      return { fake: 'scheduler' };
    }
  });

  assert.deepEqual(events, ['runtime-created', 'migration-started', 'scheduler-created']);
  assert.strictEqual(bootstrap.runtime, fakeRuntime);
  assert.deepEqual(bootstrap.scheduler, { fake: 'scheduler' });
  assert.strictEqual(bootstrap.migrationPromise, migration.promise);
});

test('app-ready continuation does not wait for a never-resolving migration promise', () => {
  const migration = deferred();
  const runtime = { startMigration: () => migration.promise };

  const bootstrap = startCodexUsageBootstrap({
    createRuntime: () => runtime,
    startScheduler: () => ({ scheduler: true })
  });

  // 同步组合立即返回句柄;迁移 Promise 永不 resolve 也不影响启动。
  assert.deepEqual(bootstrap.scheduler, { scheduler: true });
  assert.strictEqual(bootstrap.runtime, runtime);
  assert.strictEqual(bootstrap.migrationPromise, migration.promise);
});

test('startMigration promise is captured synchronously, not awaited', () => {
  let captured = null;
  const d = deferred();
  const runtime = {
    startMigration() {
      captured = d.promise;
      return d.promise;
    }
  };

  const result = startCodexUsageBootstrap({
    createRuntime: () => runtime,
    startScheduler: () => ({ scheduler: true })
  });

  assert.strictEqual(captured, d.promise);
  assert.strictEqual(result.migrationPromise, d.promise);
});

test('unexpected migration rejection reports only the safe bootstrap constant', async () => {
  const d = deferred();
  const reported = [];
  const runtime = { startMigration: () => d.promise };

  startCodexUsageBootstrap({
    createRuntime: () => runtime,
    startScheduler: () => ({}),
    onUnexpectedMigrationError: (entry) => reported.push(entry)
  });

  d.reject(new Error('internal programmer error with raw private path C:\\Users\\Alice\\.codex'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reported, [{ code: CODEX_USAGE_BOOTSTRAP_FAILED }]);
});
