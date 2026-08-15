const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  normalizeDshCollectionMode, deriveDshRootId, isDshPushSourceActive, shouldPollDshLocalLog
} = require('../src/main/core/dsh-collection-mode');

const NOW = Date.UTC(2026, 7, 16, 0, 0, 0);

function store(seed) {
  return { get(k) { return seed[k]; } };
}

test('collection mode defaults to auto and rejects unknown values', () => {
  assert.equal(normalizeDshCollectionMode(undefined), 'auto');
  assert.equal(normalizeDshCollectionMode('push'), 'push');
  assert.equal(normalizeDshCollectionMode('bogus'), 'auto');
});

test('rootId normalizes Windows separators and case', () => {
  const win = deriveDshRootId('C:\\Users\\Me\\.dsh\\telemetry', 'win32');
  const posix = deriveDshRootId('/home/me/.dsh/telemetry', 'linux');
  assert.match(win, /^root:[0-9a-f]{64}$/);
  assert.equal(win, deriveDshRootId('c:/users/me/.dsh/telemetry', 'win32'));
  assert.notEqual(win, posix);
});

test('source is active while lastIngestAt is inside the lease', () => {
  assert.equal(isDshPushSourceActive({ lastIngestAt: NOW - 1000 }, NOW, 600000), true);
  assert.equal(isDshPushSourceActive({ lastIngestAt: NOW - 600001 }, NOW, 600000), false);
});

test('auto mode suppresses only an active source with a matching rootId', () => {
  const root = path.resolve('test-fixtures', 'dsh-root');
  const rootId = deriveDshRootId(root, process.platform);
  const sources = { src1: { rootId, lastIngestAt: NOW - 1000 } };
  assert.equal(shouldPollDshLocalLog(store({
    'providers.dsh.collectionMode': 'auto',
    'ingest.dsh.sources': sources,
    'ingest.dsh.pushLeaseMs': 600000
  }), root, NOW), false);
  assert.equal(shouldPollDshLocalLog(store({
    'providers.dsh.collectionMode': 'auto',
    'ingest.dsh.sources': { src2: { rootId: 'root:' + 'f'.repeat(64), lastIngestAt: NOW } },
    'ingest.dsh.pushLeaseMs': 600000
  }), root, NOW), true);
});

test('explicit modes override auto behavior', () => {
  const root = '/tmp/any-root';
  assert.equal(shouldPollDshLocalLog(store({ 'providers.dsh.collectionMode': 'push' }), root, NOW), false);
  assert.equal(shouldPollDshLocalLog(store({ 'providers.dsh.collectionMode': 'localLog' }), root, NOW), true);
});
