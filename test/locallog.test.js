const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseRolloutLine } = require('../src/main/providers/codex/locallog');
const { parseWireLine } = require('../src/main/providers/kimi/locallog');
const { scanFiles } = require('../src/main/core/locallog');

const codexSample = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-rollout-sample.jsonl'), 'utf8').trim();
const kimiSample = fs.readFileSync(path.join(__dirname, 'fixtures', 'kimi-wire-sample.jsonl'), 'utf8').trim();

test('parseRolloutLine maps last_token_usage fields', () => {
  const rec = parseRolloutLine(codexSample);
  assert.ok(rec);
  assert.equal(new Date(rec.ts).toISOString(), '2026-08-02T13:17:43.794Z');
  assert.equal(rec.usage.input, 125209);
  assert.equal(rec.usage.cached, 123648);
  assert.equal(rec.usage.output, 109);
  assert.equal(rec.usage.reasoning, 11);
  assert.equal(rec.usage.total, 125318);
});

test('parseRolloutLine returns null for non token_count / non JSON / garbage', () => {
  assert.equal(parseRolloutLine('not json'), null);
  assert.equal(parseRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'other' } })), null);
  assert.equal(parseRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } })), null);
  assert.equal(parseRolloutLine(''), null);
});

test('parseWireLine maps kimi usage fields', () => {
  const rec = parseWireLine(kimiSample);
  assert.ok(rec);
  assert.equal(rec.ts, 1785673474235);
  assert.equal(rec.model, 'kimi-code/k3-256k');
  assert.equal(rec.usage.input, 1326);
  assert.equal(rec.usage.cached, 160512);
  assert.equal(rec.usage.output, 576);
  assert.equal(rec.usage.total, 1326 + 160512 + 576);
});

test('parseWireLine returns null for non usage.record / non JSON', () => {
  assert.equal(parseWireLine('garbage'), null);
  assert.equal(parseWireLine(JSON.stringify({ type: 'other', usage: {} })), null);
  assert.equal(parseWireLine(JSON.stringify({ type: 'usage.record' })), null);
});

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-locallog-'));
}

function makeCursorStore() {
  const data = {};
  return {
    data,
    get(k) { return data[k]; },
    set(k, v) { data[k] = v; }
  };
}

test('scanFiles reads only new bytes on subsequent scans', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-1.jsonl');
  const cursorStore = makeCursorStore();
  try {
    fs.writeFileSync(file, '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":2,"reasoning_output_tokens":1,"total_tokens":12},"total_token_usage":{}}},"timestamp":"2026-08-02T10:00:00.000Z"}\n');

    const first = await scanFiles({
      root: dir,
      match: /rollout-.*\.jsonl$/,
      cursorStore,
      cursorKey: 'cursor.test',
      providerId: 'codex',
      parseLine: parseRolloutLine
    });
    assert.equal(first.length, 1);
    assert.equal(first[0].provider, 'codex');
    assert.equal(first[0].usage.input, 10);

    fs.appendFileSync(file, '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":20,"cached_input_tokens":10,"output_tokens":4,"reasoning_output_tokens":2,"total_tokens":24},"total_token_usage":{}}},"timestamp":"2026-08-02T10:01:00.000Z"}\n');
    const second = await scanFiles({
      root: dir,
      match: /rollout-.*\.jsonl$/,
      cursorStore,
      cursorKey: 'cursor.test',
      providerId: 'codex',
      parseLine: parseRolloutLine
    });
    assert.equal(second.length, 1);
    assert.equal(second[0].usage.input, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanFiles resets offset when a file is truncated', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-2.jsonl');
  const cursorStore = makeCursorStore();
  const line = '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1,"output_tokens":0}}},"timestamp":"2026-08-02T10:00:00.000Z"}\n';
  const truncated = '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":99,"output_tokens":0}}},"timestamp":"2026-08-02T11:00:00.000Z"}\n';
  try {
    fs.writeFileSync(file, line + line + line);
    const first = await scanFiles({ root: dir, match: /rollout-.*\.jsonl$/, cursorStore, cursorKey: 'c', providerId: 'codex', parseLine: parseRolloutLine });
    assert.equal(first.length, 3);
    fs.writeFileSync(file, truncated);
    const records = await scanFiles({ root: dir, match: /rollout-.*\.jsonl$/, cursorStore, cursorKey: 'c', providerId: 'codex', parseLine: parseRolloutLine });
    assert.equal(records.length, 1);
    assert.equal(records[0].usage.input, 99);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanFiles skips a partial trailing line until it completes', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-3.jsonl');
  const cursorStore = makeCursorStore();
  try {
    fs.writeFileSync(file, '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1},"total_token_usage":{}}},"timestamp":"2026-08-02T12:00:00.000Z"}\n{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":42');
    const records = await scanFiles({ root: dir, match: /rollout-.*\.jsonl$/, cursorStore, cursorKey: 'c', providerId: 'codex', parseLine: parseRolloutLine });
    assert.equal(records.length, 1);
    fs.appendFileSync(file, '}}},"timestamp":"2026-08-02T12:01:00.000Z"}\n');
    const more = await scanFiles({ root: dir, match: /rollout-.*\.jsonl$/, cursorStore, cursorKey: 'c', providerId: 'codex', parseLine: parseRolloutLine });
    assert.equal(more.length, 1);
    assert.equal(more[0].usage.input, 42);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanFiles uses byte offsets so multi-byte content is never re-counted', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-utf8.jsonl');
  const cursorStore = makeCursorStore();
  const rec = (n) => '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":' + n + '},"total_token_usage":{}}},"timestamp":"2026-08-02T10:00:00.000Z"}\n';
  try {
    fs.writeFileSync(file, '{"type":"message","payload":{"content":"' + '汉'.repeat(200) + '"}}\n' + rec(10));
    const first = await scanFiles({ root: dir, match: /rollout-.*\.jsonl$/, cursorStore, cursorKey: 'c', providerId: 'codex', parseLine: parseRolloutLine });
    assert.equal(first.length, 1);
    assert.equal(first[0].usage.input, 10);

    fs.appendFileSync(file, rec(20));
    const second = await scanFiles({ root: dir, match: /rollout-.*\.jsonl$/, cursorStore, cursorKey: 'c', providerId: 'codex', parseLine: parseRolloutLine });
    assert.equal(second.length, 1);
    assert.equal(second[0].usage.input, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanFiles resets offset when a rotated file has an older mtime', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-rotate.jsonl');
  const cursorStore = makeCursorStore();
  const rec = (n) => '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":' + n + '},"total_token_usage":{}}},"timestamp":"2026-08-02T10:00:00.000Z"}\n';
  try {
    fs.writeFileSync(file, rec(1) + rec(2) + rec(3));
    const first = await scanFiles({ root: dir, match: /rollout-.*\.jsonl$/, cursorStore, cursorKey: 'c', providerId: 'codex', parseLine: parseRolloutLine });
    assert.equal(first.length, 3);

    fs.writeFileSync(file, rec(7) + rec(8) + rec(9) + rec(10));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(file, old, old);
    const rotated = await scanFiles({ root: dir, match: /rollout-.*\.jsonl$/, cursorStore, cursorKey: 'c', providerId: 'codex', parseLine: parseRolloutLine });
    assert.equal(rotated.length, 4);
    assert.equal(rotated[0].usage.input, 7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readLocalLog merges incremental daily rollup into store usageDaily', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'rollout-4.jsonl');
  const data = {};
  const store = {
    get(k) { return data[k]; },
    set(k, v) { data[k] = v; }
  };
  try {
    store.set('providers.codex.localLogRoot', dir);
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    const line1 = '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":10,"total_tokens":160}}},"timestamp":"' + day + 'T10:00:00.000Z"}\n';
    const line2 = '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":200,"cached_input_tokens":100,"output_tokens":20,"total_tokens":320}}},"timestamp":"' + day + 'T10:05:00.000Z"}\n';
    fs.writeFileSync(file, line1);
    const { readLocalLog } = require('../src/main/providers/codex/locallog');
    const first = await readLocalLog({ store });
    assert.equal(first.records.length, 1);
    assert.equal(first.complete, true);
    fs.appendFileSync(file, line2);
    const second = await readLocalLog({ store });
    assert.equal(second.records.length, 1);
    const key = 'codex:' + day;
    const agg = store.get('usageDaily')[key];
    assert.deepEqual(agg, { input: 300, cached: 150, output: 30, total: 480 });
    assert.equal((await readLocalLog({ store })).records.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kimi readLocalLog scans extraLogRoots and preserves cursors of unreachable roots', async () => {
  const { readLocalLog, resolveKimiLogRoots } = require('../src/main/providers/kimi/locallog');
  const { localDayStr } = require('../src/main/core/locallog');
  const dirA = makeTempDir();
  const dirB = makeTempDir();
  const data = {};
  const store = {
    get(k) { return data[k]; },
    set(k, v) { data[k] = v; }
  };
  const now = Date.now();
  const day = localDayStr(now);
  const line = (n) => '{"type":"usage.record","model":"kimi-code/k3-256k","usage":{"inputOther":' + n + ',"output":10,"inputCacheRead":0,"inputCacheCreation":0},"time":' + now + '}\n';
  try {
    const fileA = path.join(dirA, 'wire.jsonl');
    const fileB = path.join(dirB, 'nested', 'wire.jsonl');
    fs.mkdirSync(path.dirname(fileB), { recursive: true });
    fs.writeFileSync(fileA, line(100));
    fs.writeFileSync(fileB, line(200));
    store.set('providers.kimi.localLogRoot', dirA);
    store.set('providers.kimi.extraLogRoots', [dirB]);

    assert.deepEqual(resolveKimiLogRoots(store), [dirA, dirB]);

    const first = await readLocalLog({ store });
    assert.equal(first.records.length, 2);
    assert.deepEqual(store.get('usageDaily')['kimi:' + day], { input: 300, cached: 0, output: 20, total: 320 });
    assert.equal((await readLocalLog({ store })).records.length, 0);

    // 模拟附加目录不可达(如 WSL 关机):游标必须保留,恢复后不得重扫旧内容
    const goneRoot = path.join(dirB, 'not-mounted');
    store.set('providers.kimi.extraLogRoots', [goneRoot]);
    store.set('localLogCursors.kimi', Object.assign({}, store.get('localLogCursors.kimi'), {
      [path.join(goneRoot, 'wire.jsonl')]: { offset: 1234, mtimeMs: now }
    }));
    await readLocalLog({ store });
    const cursors = store.get('localLogCursors.kimi');
    assert.deepEqual(cursors[path.join(goneRoot, 'wire.jsonl')], { offset: 1234, mtimeMs: now });
    assert.equal(store.get('usageDaily')['kimi:' + day].total, 320);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('kimi readLocalLog rebuilds stale totals with cached included exactly once', async () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'wire.jsonl');
  const data = {};
  const store = {
    get(k) { return data[k]; },
    set(k, v) { data[k] = v; }
  };
  try {
    store.set('providers.kimi.localLogRoot', dir);
    const now = Date.now();
    const { localDayStr } = require('../src/main/core/locallog');
    const day = localDayStr(now);
    const line = '{"type":"usage.record","model":"kimi-code/k3-256k","usage":{"inputOther":100,"output":10,"inputCacheRead":50,"inputCacheCreation":0},"usageScope":"turn","time":' + now + '}\n';
    fs.writeFileSync(file, line);
    const usageDaily = {};
    usageDaily['kimi:' + day] = { input: 100, cached: 50, output: 10, total: 110 };
    usageDaily['codex:' + day] = { input: 1, cached: 0, output: 1, total: 2 };
    store.set('usageDaily', usageDaily);
    store.set('localLogCursors.kimi', { [file]: { offset: Number.MAX_SAFE_INTEGER, mtimeMs: now } });

    const { readLocalLog } = require('../src/main/providers/kimi/locallog');
    await readLocalLog({ store });
    assert.deepEqual(store.get('usageDaily')['kimi:' + day], { input: 100, cached: 50, output: 10, total: 160 });
    assert.deepEqual(store.get('usageDaily')['codex:' + day], { input: 1, cached: 0, output: 1, total: 2 });
    assert.equal((await readLocalLog({ store })).records.length, 0);
    assert.deepEqual(store.get('usageDaily')['kimi:' + day], { input: 100, cached: 50, output: 10, total: 160 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
