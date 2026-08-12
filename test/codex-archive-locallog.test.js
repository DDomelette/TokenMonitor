const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rolloutIdentity,
  codexEventFingerprint,
  parseRolloutLine,
  resolveCodexLogRoots,
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
