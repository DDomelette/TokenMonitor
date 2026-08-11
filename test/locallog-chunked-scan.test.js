const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanFiles } = require('../src/main/core/locallog');
const codex = require('../src/main/providers/codex/locallog');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-chunked-log-'));
}

function makeCursorStore() {
  const data = {};
  return {
    data,
    get(key) { return data[key]; },
    set(key, value) { data[key] = value; }
  };
}

function parseFixtureLine(line) {
  const data = JSON.parse(line);
  return { sequence: data.sequence, text: data.text };
}

function fixtureLine(sequence, text = '汉字🙂') {
  return JSON.stringify({ sequence, text }) + '\n';
}

async function scanFixture(dir, cursorStore, options) {
  return scanFiles(Object.assign({
    root: dir,
    match: /fixture-.*\.jsonl$/,
    cursorStore,
    cursorKey: 'cursor.fixture',
    providerId: 'fixture',
    parseLine: parseFixtureLine
  }, options));
}

test('scanFiles returns a Promise, enforces a byte budget, and resumes without duplicates', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'fixture-budget.jsonl');
  const cursorStore = makeCursorStore();
  const expected = Array.from({ length: 40 }, (_, index) => index);

  try {
    fs.writeFileSync(file, expected.map((value) => fixtureLine(value)).join(''));

    const firstPending = scanFixture(dir, cursorStore, {
      chunkBytes: 31,
      maxBytesPerScan: 93
    });
    assert.equal(typeof firstPending.then, 'function');
    const first = await firstPending;
    assert.ok(first.records.length > 0, 'the first budget should consume at least one complete line');
    assert.ok(first.records.length < expected.length, 'one scan must not consume the entire large unread tail');

    const observed = first.records.map((record) => record.sequence);
    for (let attempt = 0; attempt < 100 && observed.length < expected.length; attempt += 1) {
      const batch = await scanFixture(dir, cursorStore, {
        chunkBytes: 31,
        maxBytesPerScan: 93
      });
      observed.push(...batch.records.map((record) => record.sequence));
    }

    assert.deepEqual(observed, expected);
    assert.equal(new Set(observed).size, expected.length, 'records must never be replayed');
    assert.equal(cursorStore.data['cursor.fixture'][file].offset, fs.statSync(file).size);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('small chunks preserve UTF-8 records split across byte boundaries', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'fixture-utf8.jsonl');
  const cursorStore = makeCursorStore();
  const values = [
    { sequence: 1, text: '跨块汉字🙂A' },
    { sequence: 2, text: '第二行é漢B' }
  ];

  try {
    fs.writeFileSync(
      file,
      values.map((value) => fixtureLine(value.sequence, value.text)).join('')
    );

    const records = await scanFixture(dir, cursorStore, {
      chunkBytes: 7,
      maxBytesPerScan: 4096
    });

    assert.deepEqual(
      records.records.map(({ sequence, text }) => ({ sequence, text })),
      values
    );
    assert.equal(cursorStore.data['cursor.fixture'][file].offset, fs.statSync(file).size);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a budget ending inside a line commits only the previous newline', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'fixture-partial.jsonl');
  const cursorStore = makeCursorStore();
  const firstLine = fixtureLine(1, 'complete');
  const secondLine = fixtureLine(2, '需要跨越多个读取块🙂');
  const split = Math.floor(secondLine.length / 2);

  try {
    fs.writeFileSync(file, firstLine + secondLine.slice(0, split));

    const first = await scanFixture(dir, cursorStore, {
      chunkBytes: 11,
      maxBytesPerScan: Buffer.byteLength(firstLine) + 13
    });
    assert.deepEqual(first.records.map((record) => record.sequence), [1]);
    assert.equal(
      cursorStore.data['cursor.fixture'][file].offset,
      Buffer.byteLength(firstLine),
      'partial bytes must not be committed'
    );

    fs.appendFileSync(file, secondLine.slice(split));
    const second = await scanFixture(dir, cursorStore, {
      chunkBytes: 11,
      maxBytesPerScan: 4096
    });
    assert.deepEqual(second.records.map((record) => record.sequence), [2]);
    assert.equal(cursorStore.data['cursor.fixture'][file].offset, fs.statSync(file).size);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-block scans yield to the event loop before resolving', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'fixture-yield.jsonl');
  const cursorStore = makeCursorStore();
  let externalImmediateRan = false;
  let yielded = 0;

  try {
    fs.writeFileSync(
      file,
      Array.from({ length: 100 }, (_, index) => fixtureLine(index, 'x'.repeat(40))).join('')
    );
    setImmediate(() => { externalImmediateRan = true; });

    const records = await scanFixture(dir, cursorStore, {
      chunkBytes: 64,
      maxBytesPerScan: 2048,
      yieldToLoop: async () => {
        yielded += 1;
        await new Promise((resolve) => setImmediate(resolve));
      }
    });

    assert.ok(records.records.length > 0);
    assert.ok(yielded > 1, 'a multi-block scan must yield after multiple reads');
    assert.equal(externalImmediateRan, true, 'the main event loop must run before scan completion');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local-log providers expose asynchronous reads for the scheduler', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-async.jsonl');
  const cursorStore = makeCursorStore();
  const now = Date.now();
  const line = JSON.stringify({
    timestamp: new Date(now).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 5,
          output_tokens: 2,
          total_tokens: 12
        }
      }
    }
  }) + '\n';

  try {
    fs.writeFileSync(file, line);
    cursorStore.set('providers.codex.localLogRoot', dir);
    cursorStore.set('data.historyDays', 30);
    cursorStore.set('usageDaily', {});

    const pending = codex.readLocalLog({ store: cursorStore }, { nowMs: now });
    assert.equal(typeof pending.then, 'function');
    const batch = await pending;
    assert.equal(batch.records.length, 1);
    assert.equal(batch.complete, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('core scanner source has no synchronous traversal or unread-tail allocation', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/core/locallog.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /fs\.(?:readdirSync|statSync|openSync|readSync|closeSync)\s*\(/);
  assert.doesNotMatch(source, /Buffer\.alloc\(stat\.size\s*-\s*offset\)/);
  assert.match(source, /DEFAULT_SCAN_CHUNK_BYTES/);
  assert.match(source, /DEFAULT_SCAN_BUDGET_BYTES/);
});
