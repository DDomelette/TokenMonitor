const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const {
  parseTelemetryLine,
  resolveTelemetryRoot,
  DEFAULT_ROOT,
  MATCH
} = require('../src/main/providers/dsh/telemetrylog');

const LINE = JSON.stringify({
  v: 1, time: 1786641087069, sessionId: 'session-1', cwd: 'D:\\Deepseek_Monitor',
  model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 2000,
  cacheReadTokens: 3000, cacheWriteTokens: 100
});

test('parseTelemetryLine maps the four buckets into the UsageRecord shape', () => {
  const diagnostics = {};
  const rec = parseTelemetryLine(LINE, diagnostics, Date.now());
  assert.ok(rec);
  assert.equal(rec.ts, 1786641087069);
  assert.equal(rec.model, 'deepseek-v4-pro');
  assert.deepEqual(rec.usage, { input: 1100, cached: 3000, output: 2000, total: 6100 });
  assert.ok(typeof rec.cost === 'number' && rec.cost > 0);
  assert.match(rec.eventFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('parseTelemetryLine rejects malformed rows with diagnostics', () => {
  const diagnostics = {};
  assert.equal(parseTelemetryLine('not json', diagnostics, Date.now()), null);
  assert.equal(diagnostics.malformedLine, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ v: 2, time: 1, sessionId: 's', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.unknownRowVersion, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ time: 1, sessionId: 's', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.missingRowVersion, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ v: 1, time: 'yesterday', sessionId: 's', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.invalidTimestamp, 1);

  assert.equal(parseTelemetryLine(JSON.stringify({ v: 1, time: 1786641087069, sessionId: 's', inputTokens: -1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), diagnostics, Date.now()), null);
  assert.equal(diagnostics.invalidTokenCount, 1);
});

test('parseTelemetryLine defaults a missing model to unknown and zeroes missing cache buckets', () => {
  const rec = parseTelemetryLine(JSON.stringify({ v: 1, time: 1786641087069, sessionId: 's', inputTokens: 5, outputTokens: 6 }), {}, Date.now());
  assert.ok(rec);
  assert.equal(rec.model, 'unknown');
  assert.deepEqual(rec.usage, { input: 5, cached: 0, output: 6, total: 11 });
});

test('resolveTelemetryRoot precedence: setting > DSH_HOME env > ~/.dsh/telemetry', () => {
  assert.equal(resolveTelemetryRoot(null, {}), path.join(os.homedir(), '.dsh', 'telemetry'));
  assert.equal(resolveTelemetryRoot(null, { DSH_HOME: 'D:\\dsh-home' }), path.join('D:\\dsh-home', 'telemetry'));
  const store = { get: (key) => key === 'providers.dsh.telemetryRoot' ? 'D:\\custom' : undefined };
  assert.equal(resolveTelemetryRoot(store, { DSH_HOME: 'D:\\dsh-home' }), 'D:\\custom');
  assert.equal(resolveTelemetryRoot({ get: () => ' ' }, { DSH_HOME: ' ' }), DEFAULT_ROOT());
});

test('MATCH accepts only usage-YYYY-MM-DD.jsonl names', () => {
  assert.ok(MATCH.test('usage-2026-08-14.jsonl'));
  assert.ok(!MATCH.test('usage-2026-08-14.jsonl.tmp'));
  assert.ok(!MATCH.test('usage.jsonl'));
  assert.ok(!MATCH.test('usage-2026-13-99.jsonl'));
});
