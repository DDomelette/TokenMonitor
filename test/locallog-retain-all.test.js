const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readLocalLog: readCodexLog } = require('../src/main/providers/codex/locallog');
const { readLocalLog: readKimiLog } = require('../src/main/providers/kimi/locallog');

function makeStore(seed) {
  const data = Object.assign({}, seed);
  return { data, get(k) { return data[k]; }, set(k, v) { data[k] = v; } };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-retain-all-'));
}

const NOW_MS = new Date('2026-08-07T12:00:00').getTime();
const OLD_TS = new Date('2026-06-17T10:00:00').getTime();

function localDayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const OLD_DAY = localDayKey(OLD_TS);

function writeCodexFile(dir) {
  fs.writeFileSync(path.join(dir, 'rollout-old.jsonl'),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2, total_tokens: 12 } } },
      timestamp: '2026-06-17T10:00:00.000Z'
    }) + '\n');
}

function writeKimiFile(dir) {
  fs.writeFileSync(path.join(dir, 'wire.jsonl'),
    JSON.stringify({ type: 'usage.record', time: OLD_TS, model: 'kimi-code/k3', usage: { inputOther: 1, inputCacheRead: 2, output: 3 } }) + '\n');
}

test('codex readLocalLog 默认按保留窗口过滤旧日聚合', async () => {
  const dir = makeTempDir();
  writeCodexFile(dir);
  const store = makeStore({ 'providers.codex.localLogRoot': dir, 'data.historyDays': 1 });
  const batch = await readCodexLog({ store }, { nowMs: NOW_MS });
  assert.equal(batch.records.length, 1);
  assert.equal(batch.complete, true);
  const usageDaily = store.data.usageDaily || {};
  assert.equal(usageDaily['codex:' + OLD_DAY], undefined);
});

test('codex readLocalLog retainAll 保留窗口外旧日聚合(全量重扫用)', async () => {
  const dir = makeTempDir();
  writeCodexFile(dir);
  const store = makeStore({ 'providers.codex.localLogRoot': dir, 'data.historyDays': 1 });
  const batch = await readCodexLog({ store }, { nowMs: NOW_MS, retainAll: true });
  assert.equal(batch.records.length, 1);
  assert.equal(batch.complete, true);
  const usageDaily = store.data.usageDaily || {};
  assert.equal((usageDaily['codex:' + OLD_DAY] || {}).total, 12);
});

test('kimi readLocalLog 默认按保留窗口过滤旧日聚合', async () => {
  const dir = makeTempDir();
  writeKimiFile(dir);
  const store = makeStore({ 'providers.kimi.localLogRoot': dir, 'data.historyDays': 1 });
  const batch = await readKimiLog({ store }, { nowMs: NOW_MS });
  assert.equal(batch.records.length, 1);
  assert.equal(batch.complete, true);
  const usageDaily = store.data.usageDaily || {};
  assert.equal(usageDaily['kimi:' + OLD_DAY], undefined);
});

test('kimi readLocalLog retainAll 保留窗口外旧日聚合(全量重扫用)', async () => {
  const dir = makeTempDir();
  writeKimiFile(dir);
  const store = makeStore({ 'providers.kimi.localLogRoot': dir, 'data.historyDays': 1 });
  const batch = await readKimiLog({ store }, { nowMs: NOW_MS, retainAll: true });
  assert.equal(batch.records.length, 1);
  assert.equal(batch.complete, true);
  const usageDaily = store.data.usageDaily || {};
  assert.equal((usageDaily['kimi:' + OLD_DAY] || {}).total, 6);
});
