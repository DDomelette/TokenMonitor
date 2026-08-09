const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findMatchingFiles,
  readJsonlSample
} = require('../src/main/core/diagnostics/readonly-log');
const { createProviderChecks } = require('../src/main/core/diagnostics/checks/providers');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-diagnostics-providers-'));
}

function futureJwt() {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return header + '.' + payload + '.signature';
}

test('read-only log helpers cap entries and tail bytes without following a symlink', () => {
  const root = tempDir();
  const outside = tempDir();
  try {
    fs.writeFileSync(path.join(outside, 'rollout-outside.jsonl'), '{"outside":true}\n');
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'rollout-first.jsonl'), '{"inside":true}\n');
    for (let index = 0; index < 8; index += 1) {
      fs.writeFileSync(path.join(root, 'file-' + index + '.txt'), 'x');
    }
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch (_) {
      // Environments without symlink privileges still exercise the bounded walk.
    }

    const matches = findMatchingFiles({
      root,
      match: /^rollout-.*\.jsonl$/,
      fs,
      maxEntries: 5
    });
    assert.ok(matches.length <= 1);
    assert.ok(matches.every((file) => !file.includes('outside')));
    if (linked) assert.ok(matches.every((file) => !file.includes('linked')));

    const sampleFile = path.join(root, 'sample.jsonl');
    const first = JSON.stringify({ first: 'discarded' });
    const final = JSON.stringify({ last: 'kept' });
    fs.writeFileSync(sampleFile, first + '\n' + 'x'.repeat(96) + '\n' + final + '\n');
    const lines = readJsonlSample({ file: sampleFile, fs, maxBytes: 64, maxLines: 1 });
    assert.deepEqual(lines, [final]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('provider checks read raw snapshots without Store mutations, refreshes, adapters, or cursor keys', async () => {
  const root = tempDir();
  try {
    const codexRoot = path.join(root, 'codex-sessions');
    const kimiRoot = path.join(root, 'kimi-sessions');
    const codexAuthPath = path.join(root, 'auth.json');
    const kimiCredPath = path.join(root, 'kimi-code.json');
    fs.mkdirSync(path.join(codexRoot, 'run'), { recursive: true });
    fs.mkdirSync(path.join(kimiRoot, 'run'), { recursive: true });
    fs.writeFileSync(codexAuthPath, JSON.stringify({
      tokens: { access_token: futureJwt(), refresh_token: 'codex-refresh-secret', account_id: 'acct-secret' }
    }));
    fs.writeFileSync(kimiCredPath, JSON.stringify({
      access_token: 'kimi-access-secret', refresh_token: 'kimi-refresh-secret', expires_at: Math.floor(Date.now() / 1000) + 3600
    }));
    fs.writeFileSync(path.join(codexRoot, 'run', 'rollout-a.jsonl'), JSON.stringify({
      type: 'event_msg', timestamp: new Date().toISOString(), payload: {
        type: 'token_count', info: { last_token_usage: { input_tokens: 2, total_tokens: 2 } }
      }
    }) + '\n');
    fs.writeFileSync(path.join(kimiRoot, 'run', 'wire.jsonl'), JSON.stringify({
      type: 'usage.record', time: Date.now(), usage: { inputOther: 1, inputCacheRead: 2, output: 3 }
    }) + '\n');
    const codexBefore = fs.readFileSync(codexAuthPath);
    const kimiBefore = fs.readFileSync(kimiCredPath);
    const reads = [];
    const mutations = [];
    const forbidden = () => { throw new Error('forbidden provider adapter call'); };
    const httpCalls = [];
    const checks = createProviderChecks({
      fs,
      store: {
        get(key) {
          reads.push(key);
          return key === 'providers.deepseek.apiKey' ? 'deepseek-api-secret'
            : key === 'providers.deepseek.sessionToken' ? 'deepseek-session-secret'
              : key === 'providers.proxyUrl' ? '' : undefined;
        },
        set(...args) { mutations.push(['set', ...args]); },
        delete(...args) { mutations.push(['delete', ...args]); },
        clear(...args) { mutations.push(['clear', ...args]); }
      },
      codexAuthPath,
      codexSessionsRoot: codexRoot,
      kimiCredPath,
      kimiSessionsRoot: kimiRoot,
      ensureFresh: forbidden,
      refreshAuth: forbidden,
      refreshCred: forbidden,
      codexProvider: { fetchQuota: forbidden, readLocalLog: forbidden },
      kimiProvider: { fetchQuota: forbidden, readLocalLog: forbidden },
      fetchBalance: async () => ({ available: true }),
      UsageFetcher: class { async fetchUsageAmount() { return { aggregate: { totalTokens: 1 } }; } },
      httpGet: async (url, headers, proxy) => {
        httpCalls.push({ url, headers, proxy });
        return { rate_limit: { primary_window: { used_percent: 1 } }, usage: { used: 1, limit: 2, remaining: 1 } };
      }
    });

    assert.deepEqual(checks.map((check) => check.id), [
      'deepseek.api-key', 'deepseek.session', 'codex.auth', 'codex.sessions',
      'codex.local-log', 'codex.quota', 'kimi.auth', 'kimi.sessions',
      'kimi.local-log', 'kimi.quota'
    ]);
    assert.ok(checks.every((check) => check.phase === 'remote' || check.phase === 'local'));
    assert.equal(checks.find((check) => check.id === 'deepseek.api-key').timeoutMs, 12000);
    assert.equal(checks.find((check) => check.id === 'deepseek.session').timeoutMs, 12000);
    const results = await Promise.all(checks.map((check) => check.run()));
    assert.equal(results.every((result) => result.status === 'pass'), true);
    assert.deepEqual(mutations, []);
    assert.equal(reads.some((key) => /cursor|migration|usageDaily/i.test(key)), false);
    assert.deepEqual(fs.readFileSync(codexAuthPath), codexBefore);
    assert.deepEqual(fs.readFileSync(kimiCredPath), kimiBefore);
    assert.equal(httpCalls.length, 2);
    const safe = JSON.stringify(results);
    assert.doesNotMatch(safe, /secret|signature|acct-secret|auth\.json|kimi-code\.json|rollout-a|wire\.jsonl/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('malformed dependencies and rejected quota requests become safe check results', async () => {
  const checks = createProviderChecks({
    store: null,
    httpGet: () => Promise.reject(Object.assign(new Error('private token'), { code: 'EFAIL' }))
  });
  assert.equal(checks.length, 10);
  const results = await Promise.all(checks.map(async (check) => {
    try { return await check.run(); } catch (error) { return { thrown: error }; }
  }));
  assert.equal(results.some((result) => result.thrown), false);
  assert.doesNotMatch(JSON.stringify(results), /private token|token|auth\.json|kimi-code/);
});

test('provider check definitions keep credential and local-log probes local and quota probes remote', () => {
  const checks = createProviderChecks({});
  const byId = new Map(checks.map((check) => [check.id, check]));
  for (const id of ['codex.auth', 'codex.sessions', 'codex.local-log', 'kimi.auth', 'kimi.sessions', 'kimi.local-log']) {
    assert.equal(byId.get(id).phase, 'local');
    assert.equal(byId.get(id).timeoutMs, 8000);
  }
  for (const id of ['deepseek.api-key', 'deepseek.session', 'codex.quota', 'kimi.quota']) {
    assert.equal(byId.get(id).phase, 'remote');
    assert.equal(byId.get(id).timeoutMs, 12000);
  }
  assert.equal(byId.get('codex.local-log').guideId, 'codex-local-log');
  assert.equal(byId.get('kimi.local-log').guideId, 'kimi-local-log');
});
