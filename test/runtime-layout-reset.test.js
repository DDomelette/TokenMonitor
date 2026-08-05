const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadSync() {
  return import('../renderer/src/layout-reset-sync.js');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('runtime layout reset emits once per authoritative layout-to-null transition', async () => {
  const { installLayoutResetSync } = await loadSync();
  let handler;
  let unsubscribeCalls = 0;
  let resets = 0;

  const cleanup = installLayoutResetSync({
    getSettings: async () => ({ layout: { compact: {}, wide: {} } }),
    on(channel, callback) {
      assert.equal(channel, 'settings:loaded');
      handler = callback;
      return () => { unsubscribeCalls += 1; };
    },
    onReset: () => { resets += 1; }
  });

  await flushEvents();
  assert.equal(resets, 0);

  handler({ layout: null });
  assert.equal(resets, 1);
  handler({ layout: null });
  assert.equal(resets, 1, 'repeated null snapshots must not remount repeatedly');

  handler({ layout: { compact: {}, wide: {} } });
  assert.equal(resets, 1);
  handler({ layout: null });
  assert.equal(resets, 2, 'a later persisted layout can be reset again');

  cleanup();
  assert.equal(unsubscribeCalls, 1);
  handler({ layout: { compact: {}, wide: {} } });
  handler({ layout: null });
  assert.equal(resets, 2, 'disposed controllers ignore later broadcasts');
});

test('a live null layout before the initial read is authoritative and suppresses the stale initial result', async () => {
  const { installLayoutResetSync } = await loadSync();
  const initial = deferred();
  let handler;
  let resets = 0;

  const cleanup = installLayoutResetSync({
    getSettings: () => initial.promise,
    on(_channel, callback) {
      handler = callback;
      return () => {};
    },
    onReset: () => { resets += 1; }
  });

  handler({ layout: null });
  assert.equal(resets, 1);

  initial.resolve({ layout: { compact: { stale: true }, wide: { stale: true } } });
  await flushEvents();
  assert.equal(resets, 1, 'stale initial settings must not alter live reset tracking');

  handler({ layout: null });
  assert.equal(resets, 1);
  cleanup();
});

test('initial null layout establishes the baseline without treating startup as a reset', async () => {
  const { installLayoutResetSync } = await loadSync();
  let resets = 0;

  const cleanup = installLayoutResetSync({
    getSettings: async () => ({ layout: null }),
    on: () => () => {},
    onReset: () => { resets += 1; }
  });

  await flushEvents();
  assert.equal(resets, 0);
  cleanup();
});

test('App remounts Dashboard through a generation key when the persisted layout resets', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/App.jsx'),
    'utf8'
  );

  assert.match(source, /import \{ installLayoutResetSync \} from '\.\/layout-reset-sync\.js';/);
  assert.match(source, /const \[dashboardGeneration, setDashboardGeneration\] = useState\(0\);/);
  assert.match(source, /useEffect\(\(\) => installLayoutResetSync\(\{/);
  assert.match(source, /onReset:\s*\(\) => setDashboardGeneration\(\(generation\) => generation \+ 1\)/);
  assert.match(
    source,
    /<Dashboard key=\{dashboardGeneration\} editing=\{effectiveEditing\} \/>/
  );
});

test('Dashboard fresh mount rebuilds both layouts and cleanup cannot write the old layout back', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/components/Dashboard.jsx'),
    'utf8'
  );

  assert.match(
    source,
    /layoutRef\.current = validateState\(normalizedSettings\.layout, normalizedSettings\);/
  );
  assert.match(
    source,
    /return \(\) => \{[\s\S]*?grid\.off\('change'\);[\s\S]*?grid\.destroy\(false\);/
  );
  assert.doesNotMatch(
    source,
    /return \(\) => \{[\s\S]*?send\('settings:update', \{ key: 'layout'/
  );
});
