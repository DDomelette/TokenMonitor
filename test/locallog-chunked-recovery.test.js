const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanFiles } = require('../src/main/core/locallog');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-chunk-recovery-'));
}

function makeCursorStore() {
  const values = {};
  return {
    values,
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; }
  };
}

function line(sequence, text = 'payload') {
  return JSON.stringify({ sequence, text }) + '\n';
}

function scan(root, store, parseLine, options = {}) {
  return scanFiles(Object.assign({
    root,
    match: /fixture\.jsonl$/,
    cursorStore: store,
    cursorKey: 'cursor.fixture',
    providerId: 'fixture',
    parseLine
  }, options));
}

test('budget exhaustion finishes only the already-started line and never requests an oversized block', async (t) => {
  const root = makeTempDir();
  const file = path.join(root, 'fixture.jsonl');
  const store = makeCursorStore();
  const lines = Array.from({ length: 12 }, (_, index) => line(index + 1, 'x'.repeat(12)));
  const requestedReadLengths = [];
  const originalOpen = fs.promises.open;

  fs.promises.open = async (...args) => {
    const handle = await originalOpen.call(fs.promises, ...args);
    return {
      read(buffer, offset, length, position) {
        requestedReadLengths.push(length);
        return handle.read(buffer, offset, length, position);
      },
      close() {
        return handle.close();
      }
    };
  };
  t.after(() => {
    fs.promises.open = originalOpen;
    fs.rmSync(root, { recursive: true, force: true });
  });

  fs.writeFileSync(file, lines.join(''));

  const records = await scan(
    root,
    store,
    (raw) => JSON.parse(raw),
    { chunkBytes: 128, maxBytesPerScan: 50 }
  );

  assert.deepEqual(records.map((record) => record.sequence), [1, 2]);
  assert.equal(
    store.values['cursor.fixture'][file].offset,
    Buffer.byteLength(lines[0] + lines[1]),
    'bytes read after the completed budget-started line must be reread next time'
  );
  assert.ok(requestedReadLengths.length >= 2);
  assert.ok(
    requestedReadLengths.every((length) => length <= 128),
    `oversized read request: ${requestedReadLengths.join(', ')}`
  );
});

test('a parser failure commits prior lines and replays the failing line on recovery', async () => {
  const root = makeTempDir();
  const file = path.join(root, 'fixture.jsonl');
  const store = makeCursorStore();
  const lines = [line(1), line(2), line(3)];
  let failSecond = true;

  try {
    fs.writeFileSync(file, lines.join(''));

    await assert.rejects(
      scan(root, store, (raw) => {
        const parsed = JSON.parse(raw);
        if (failSecond && parsed.sequence === 2) throw new Error('fixture parser failure');
        return parsed;
      }),
      /fixture parser failure/
    );

    assert.equal(
      store.values['cursor.fixture'][file].offset,
      Buffer.byteLength(lines[0]),
      'the throwing line itself must remain uncommitted'
    );

    failSecond = false;
    const recovered = await scan(root, store, (raw) => JSON.parse(raw));
    assert.deepEqual(recovered.map((record) => record.sequence), [2, 3]);
    assert.equal(store.values['cursor.fixture'][file].offset, fs.statSync(file).size);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scheduler awaits asynchronous local-log providers before finishing the channel', async () => {
  const { startScheduler } = require('../src/main/core/scheduler');
  let release;
  let started = false;
  let settled = false;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const provider = {
    id: 'fixture',
    displayName: 'Fixture',
    capabilities: {
      balance: false,
      webUsage: false,
      quota: false,
      localLog: true
    },
    authStatus() {
      return 'ok';
    },
    async readLocalLog() {
      started = true;
      await blocked;
    }
  };
  const registry = {
    list() {
      return [provider];
    },
    get(id) {
      return id === provider.id ? provider : undefined;
    }
  };
  const scheduler = startScheduler({
    registry,
    store: { get() { return null; } },
    broadcast() {},
    intervals: false
  });
  const poll = scheduler.poll(provider.id, 'localLog').then(() => {
    settled = true;
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, true);
    assert.equal(settled, false, 'poll must remain pending while the provider scan is blocked');

    release();
    await poll;
    assert.equal(settled, true);
  } finally {
    release();
    await poll.catch(() => {});
    scheduler.stop();
  }
});
