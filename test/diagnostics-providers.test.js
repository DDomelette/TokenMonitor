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

test('isolated provider fixtures normalize rejected quota errors without exposing private paths or error text', async () => {
  const root = tempDir();
  const nowMs = 2_000_000_000_000;
  const rejectedQuotaSentinel = 'rejected-quota-private-sentinel-39c9d1';
  const codexAuthPath = path.join(root, 'codex-sensitive-credentials.json');
  const kimiCredPath = path.join(root, 'kimi-sensitive-credentials.json');
  const codexSessionsRoot = path.join(root, 'codex-sensitive-sessions');
  const kimiSessionsRoot = path.join(root, 'kimi-sensitive-sessions');
  try {
    fs.mkdirSync(path.join(codexSessionsRoot, 'run'), { recursive: true });
    fs.mkdirSync(path.join(kimiSessionsRoot, 'run'), { recursive: true });
    fs.writeFileSync(codexAuthPath, JSON.stringify({
      tokens: { access_token: 'codex-fixture-access', refresh_token: 'codex-fixture-refresh', account_id: 'codex-fixture-account' }
    }));
    fs.writeFileSync(kimiCredPath, JSON.stringify({
      access_token: 'kimi-fixture-access', refresh_token: 'kimi-fixture-refresh', expires_at: nowMs / 1000 + 3600
    }));
    fs.writeFileSync(path.join(codexSessionsRoot, 'run', 'rollout-fixture.jsonl'), '{"type":"event_msg"}\n');
    fs.writeFileSync(path.join(kimiSessionsRoot, 'run', 'wire-fixture.jsonl'), '{"type":"usage.record"}\n');

    const checks = createProviderChecks({
      fs,
      store: { get() { return undefined; } },
      now: () => nowMs,
      tokenExpiryMs: () => nowMs + 3600_000,
      codexAuthPath,
      codexSessionsRoot,
      kimiCredPath,
      kimiSessionsRoot,
      httpGet: async () => { throw Object.assign(new Error(rejectedQuotaSentinel), { code: 'EFAIL' }); }
    });
    assert.equal(checks.length, 10);
    const results = await Promise.all(checks.map(async (check) => {
      try { return { id: check.id, result: await check.run() }; } catch (error) { return { id: check.id, thrown: error }; }
    }));
    assert.equal(results.some((entry) => entry.thrown), false);
    assert.deepEqual(
      results.filter((entry) => entry.result.errorCode === 'QUOTA_REQUEST_FAILED').map((entry) => entry.id),
      ['codex.quota', 'kimi.quota']
    );
    const safe = JSON.stringify(results);
    assert.equal(safe.includes(rejectedQuotaSentinel), false);
    for (const sensitivePath of [codexAuthPath, kimiCredPath, codexSessionsRoot, kimiSessionsRoot]) {
      assert.equal(safe.includes(sensitivePath), false);
      assert.equal(safe.includes(path.basename(sensitivePath)), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('provider remote checks share the run proxy snapshot and propagate the check signal and deadline', async () => {
  const calls = [];
  let legacyProxyReads = 0;
  const signal = new AbortController().signal;
  const httpGet = async (url, headers, proxyInput, timeoutOptions) => {
    calls.push({ url, proxyInput, timeoutOptions });
    return {};
  };
  class UsageFetcher {
    fetchUsageAmount(_token, _month, _year, options) {
      return options.httpGet('https://platform.example/usage', {}, options.proxyUrl, { requestTimeoutMs: 7 });
    }
  }
  const checks = createProviderChecks({
    getDeepseekApiKey: () => 'deepseek-key',
    getDeepseekSessionToken: () => 'deepseek-session',
    getProxyUrl() { legacyProxyReads += 1; throw new Error('legacy proxy getter must not run'); },
    fetchBalance(_key, options) {
      return options.httpGet('https://balance.example/read', {}, options.proxyUrl, { requestTimeoutMs: 6 });
    },
    UsageFetcher,
    httpGet,
    now: () => 1_000,
    tokenExpiryMs: () => 1_000_000_000,
    codexAuthPath: 'codex-auth.json',
    kimiCredPath: 'kimi-cred.json',
    fs: {
      readFileSync(file) {
        if (file === 'codex-auth.json') {
          return Buffer.from(JSON.stringify({ tokens: {
            access_token: 'codex-access', refresh_token: 'codex-refresh', account_id: 'account'
          } }));
        }
        if (file === 'kimi-cred.json') {
          return Buffer.from(JSON.stringify({
            access_token: 'kimi-access', refresh_token: 'kimi-refresh', expires_at: 1_000_000
          }));
        }
        throw new Error('unexpected file');
      }
    }
  });
  const context = {
    signal,
    deadlineMs: 54321,
    runScope: { proxy: { mode: 'custom', input: 'http://proxy.example.test:8080' } }
  };

  const results = await Promise.all([
    'deepseek.api-key', 'deepseek.session', 'codex.quota', 'kimi.quota'
  ].map((id) => checks.find((check) => check.id === id).run(context)));

  assert.equal(results.every((result) => result.status === 'pass'), true, JSON.stringify(results));
  assert.equal(legacyProxyReads, 0);
  assert.equal(calls.length, 4);
  assert.equal(calls.every((call) => call.proxyInput === 'http://proxy.example.test:8080'), true);
  assert.equal(calls.every((call) => call.timeoutOptions.signal === signal), true);
  assert.equal(calls.every((call) => call.timeoutOptions.deadlineMs === 54321), true);
});

test('async credential and proxy configuration is awaited without leaked rejections', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const calls = [];
    const checks = createProviderChecks({
      getDeepseekApiKey: () => Promise.resolve('deepseek-secret'),
      getDeepseekSessionToken: () => Promise.reject(new Error('private session getter failure')),
      getProxyUrl: () => Promise.reject(new Error('private proxy getter failure')),
      fetchBalance: async (key, options) => {
        calls.push({ key, proxyUrl: options.proxyUrl });
        return { available: true };
      },
      UsageFetcher: class { async fetchUsageAmount() { throw new Error('must not receive a token'); } }
    });
    const api = await checks.find((check) => check.id === 'deepseek.api-key').run();
    const session = await checks.find((check) => check.id === 'deepseek.session').run();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(api.status, 'pass');
    assert.equal(session.status, 'skipped');
    assert.deepEqual(calls, [{ key: 'deepseek-secret', proxyUrl: null }]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('async Store credential and proxy reads are awaited without leaked rejections', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const calls = [];
    const checks = createProviderChecks({
      store: {
        get(key) {
          if (key === 'providers.deepseek.apiKey') return Promise.resolve('deepseek-store-secret');
          if (key === 'providers.deepseek.sessionToken' || key === 'providers.proxyUrl') return Promise.reject(new Error('private Store rejection'));
          return undefined;
        }
      },
      fetchBalance: async (key, options) => {
        calls.push({ key, proxyUrl: options.proxyUrl });
        return { available: true };
      }
    });
    const api = await checks.find((check) => check.id === 'deepseek.api-key').run();
    const session = await checks.find((check) => check.id === 'deepseek.session').run();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(api.status, 'pass');
    assert.equal(session.status, 'skipped');
    assert.deepEqual(calls, [{ key: 'deepseek-store-secret', proxyUrl: null }]);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('provider factory fails closed when configuration getters throw during construction', () => {
  const dependencies = {};
  Object.defineProperty(dependencies, 'fs', { get() { throw new Error('private fs failure'); } });
  Object.defineProperty(dependencies, 'store', { get() { throw new Error('private store failure'); } });
  assert.doesNotThrow(() => createProviderChecks(dependencies));
  assert.equal(createProviderChecks(dependencies).length, 10);
});

test('unreadable discovered local logs fail while readable empty logs still pass', () => {
  const root = tempDir();
  try {
    const sessions = path.join(root, 'sessions');
    const auth = path.join(root, 'auth.json');
    fs.mkdirSync(sessions);
    fs.writeFileSync(auth, JSON.stringify({ tokens: {} }));
    const log = path.join(sessions, 'rollout-empty.jsonl');
    fs.writeFileSync(log, '');
    const readable = createProviderChecks({ fs, codexAuthPath: auth, codexSessionsRoot: sessions });
    assert.equal(readable.find((check) => check.id === 'codex.local-log').run().status, 'pass');

    fs.writeFileSync(log, '{"partial":true}\n');
    const unreadableFs = Object.assign({}, fs, {
      readSync() { throw new Error('not readable'); }
    });
    const unreadable = createProviderChecks({ fs: unreadableFs, codexAuthPath: auth, codexSessionsRoot: sessions });
    assert.deepEqual(unreadable.find((check) => check.id === 'codex.sessions').run().status, 'fail');
    assert.deepEqual(unreadable.find((check) => check.id === 'codex.local-log').run(), {
      status: 'fail',
      summary: 'Local log sample could not be read safely',
      errorCode: 'LOCAL_LOG_UNREADABLE',
      metadata: { matchingFiles: 1, sampledLines: 0, parsedRecords: 0 }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Kimi expiry metadata classifies only semantic expiry timestamps', () => {
  const root = tempDir();
  try {
    const credPath = path.join(root, 'kimi.json');
    const nowMs = 2_000_000_000_000;
    const cases = [
      [Math.floor(nowMs / 1000) + 3600, 'valid'],
      [Math.floor(nowMs / 1000) + 60, 'near-expiry'],
      [0, 'expired'],
      [-1, 'expired'],
      [null, 'unknown'],
      ['', 'unknown'],
      ['   ', 'unknown'],
      [false, 'unknown'],
      [undefined, 'unknown'],
      ['not-a-number', 'unknown']
    ];
    for (const [expiresAt, expiry] of cases) {
      const payload = { access_token: 'kimi-secret', refresh_token: 'refresh-secret' };
      if (expiresAt !== undefined) payload.expires_at = expiresAt;
      fs.writeFileSync(credPath, JSON.stringify(payload));
      const auth = createProviderChecks({ fs, kimiCredPath: credPath, now: () => nowMs })
        .find((check) => check.id === 'kimi.auth').run();
      assert.equal(auth.metadata.expiry, expiry);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bounded discovery counts only child entries and caps matching files at twenty', () => {
  const childNames = Array.from({ length: 2105 }, (_, index) => 'rollout-' + String(index).padStart(4, '0') + '.jsonl');
  const inspected = [];
  const fakeFs = {
    lstatSync(target) {
      if (target === 'root') return { isSymbolicLink: () => false, isDirectory: () => true };
      inspected.push(target);
      return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
    },
    readdirSync() { return childNames; }
  };
  const matches = findMatchingFiles({ root: 'root', match: /^rollout-.*\.jsonl$/, fs: fakeFs, maxEntries: 99999 });
  assert.equal(matches.length, 20);
  assert.equal(inspected.length, 20, 'the first twenty matching children stop further entry inspection');

  const noMatches = findMatchingFiles({ root: 'root', match: /^never$/, fs: fakeFs, maxEntries: 99999 });
  assert.equal(noMatches.length, 0);
  assert.equal(inspected.length, 2020, 'the root is not counted; the second walk inspects exactly the 2000-entry cap');
  assert.deepEqual(findMatchingFiles(null), []);
  assert.deepEqual(findMatchingFiles({ root: 'root', match: /^x$/, fs: { lstatSync() { throw new Error('private fs error'); }, readdirSync() { return []; } } }), []);
});

test('JSONL sampling caps tail reads and handles partial, CRLF, short-read, and close-error paths', () => {
  const tailContent = Buffer.from('discarded-prefix-without-newline\nkeep-one\r\nkeep-two\r\ntrailing-partial');
  const readCalls = [];
  let closes = 0;
  const tailFs = {
    statSync() { return { size: tailContent.length }; },
    openSync() { return 7; },
    readSync(fd, target, offset, length, position) {
      readCalls.push({ fd, length, position, bufferLength: target.length });
      tailContent.copy(target, offset, position, position + length);
      return Math.min(length, tailContent.length - position);
    },
    closeSync() { closes += 1; }
  };
  assert.deepEqual(readJsonlSample({ file: 'tail.jsonl', fs: tailFs, maxBytes: 40, maxLines: 100 }), ['keep-one', 'keep-two']);
  assert.equal(readCalls[0].length <= 40, true);
  assert.equal(readCalls[0].bufferLength <= 40, true);
  assert.equal(readCalls[0].position, tailContent.length - 40);
  assert.equal(closes, 1);

  const allLines = Array.from({ length: 103 }, (_, index) => 'line-' + index + '\n').join('');
  const linesBuffer = Buffer.from(allLines);
  const manyLinesFs = {
    statSync() { return { size: linesBuffer.length }; },
    openSync() { return 8; },
    readSync(fd, target, offset, length, position) {
      linesBuffer.copy(target, offset, position, position + length);
      return Math.min(length, linesBuffer.length - position);
    },
    closeSync() { throw new Error('close failure'); }
  };
  const lines = readJsonlSample({ file: 'many.jsonl', fs: manyLinesFs, maxBytes: 65536, maxLines: 999 });
  assert.equal(lines.length, 100);
  assert.equal(lines[0], 'line-3');
  assert.equal(lines.at(-1), 'line-102');

  const shortFs = {
    statSync() { return { size: 6 }; },
    openSync() { return 9; },
    readSync(fd, target) { Buffer.from('a\nb\n').copy(target); return 4; },
    closeSync() {}
  };
  assert.deepEqual(readJsonlSample({ file: 'short.jsonl', fs: shortFs, maxBytes: 8 }), ['a', 'b']);
  assert.equal(readJsonlSample(null), null);
});

test('all provider definitions expose the fixed public contract', () => {
  assert.deepEqual(createProviderChecks({}).map(({ id, group, title, guideId, phase, timeoutMs }) => ({ id, group, title, guideId, phase, timeoutMs })), [
    { id: 'deepseek.api-key', group: 'Providers', title: 'DeepSeek API key', guideId: 'deepseek-api-key', phase: 'remote', timeoutMs: 12000 },
    { id: 'deepseek.session', group: 'Providers', title: 'DeepSeek platform session', guideId: 'deepseek-session', phase: 'remote', timeoutMs: 12000 },
    { id: 'codex.auth', group: 'Providers', title: 'Codex credential snapshot', guideId: 'codex-auth', phase: 'local', timeoutMs: 8000 },
    { id: 'codex.sessions', group: 'Providers', title: 'Codex local sessions', guideId: 'codex-local-log', phase: 'local', timeoutMs: 8000 },
    { id: 'codex.local-log', group: 'Providers', title: 'Codex local log sample', guideId: 'codex-local-log', phase: 'local', timeoutMs: 8000 },
    { id: 'codex.quota', group: 'Providers', title: 'Codex quota endpoint', guideId: 'codex-auth', phase: 'remote', timeoutMs: 12000 },
    { id: 'kimi.auth', group: 'Providers', title: 'Kimi credential snapshot', guideId: 'kimi-auth', phase: 'local', timeoutMs: 8000 },
    { id: 'kimi.sessions', group: 'Providers', title: 'Kimi local sessions', guideId: 'kimi-local-log', phase: 'local', timeoutMs: 8000 },
    { id: 'kimi.local-log', group: 'Providers', title: 'Kimi local log sample', guideId: 'kimi-local-log', phase: 'local', timeoutMs: 8000 },
    { id: 'kimi.quota', group: 'Providers', title: 'Kimi quota endpoint', guideId: 'kimi-auth', phase: 'remote', timeoutMs: 12000 }
  ]);
});

test('factory snapshots synchronous dependencies once and consumes rejected configuration thenables', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    let fetchGetterReads = 0;
    const dependencies = {
      fs: Promise.reject(new Error('private fs promise')),
      path: Promise.reject(new Error('private path promise')),
      now: Promise.reject(new Error('private clock promise')),
      UsageFetcher: Promise.reject(new Error('private fetcher promise')),
      httpGet: Promise.reject(new Error('private HTTP promise')),
      tokenExpiryMs: Promise.reject(new Error('private expiry promise')),
      codexAuthPath: Promise.reject(new Error('private auth path promise')),
      codexSessionsRoot: Promise.reject(new Error('private sessions path promise')),
      kimiCredPath: Promise.reject(new Error('private credential path promise')),
      kimiSessionsRoot: Promise.reject(new Error('private Kimi sessions path promise')),
      parseRolloutLine: Promise.reject(new Error('private rollout parser promise')),
      parseWireLine: Promise.reject(new Error('private wire parser promise'))
    };
    Object.defineProperty(dependencies, 'fetchBalance', {
      get() {
        fetchGetterReads += 1;
        return fetchGetterReads === 1
          ? async () => ({ available: true })
          : Promise.reject(new Error('second getter read'));
      }
    });
    dependencies.store = {
      get(key) {
        if (key === 'providers.codex.localLogRoot') {
          return { then(resolve) { resolve('ignored'); return Promise.reject(new Error('root chain rejection')); } };
        }
        return undefined;
      }
    };
    assert.doesNotThrow(() => createProviderChecks(dependencies));
    assert.equal(fetchGetterReads, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('controlled async configuration assimilation contains returned thenable rejections', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const calls = [];
    const checks = createProviderChecks({
      getDeepseekApiKey: () => ({
        then(resolve) {
          resolve('resolved-custom-key');
          return Promise.reject(new Error('custom then chain rejection'));
        }
      }),
      fetchBalance: async (key) => { calls.push(key); return { available: true }; }
    });
    assert.deepEqual(await checks.find((check) => check.id === 'deepseek.api-key').run(), {
      status: 'pass', summary: 'DeepSeek API key was accepted', metadata: { configured: true }
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['resolved-custom-key']);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('empty samples must open successfully and helper method getters fail closed', () => {
  const emptyFs = {
    statSync() { return { size: 0 }; },
    openSync() { throw new Error('empty file is unreadable'); },
    readSync() { throw new Error('must not read'); },
    closeSync() { throw new Error('must not close'); }
  };
  assert.equal(readJsonlSample({ file: 'empty.jsonl', fs: emptyFs }), null);

  const throwingFindFs = {};
  Object.defineProperty(throwingFindFs, 'lstatSync', { get() { throw new Error('private lstat getter'); } });
  Object.defineProperty(throwingFindFs, 'readdirSync', { get() { throw new Error('private readdir getter'); } });
  const throwingReadFs = {};
  for (const key of ['statSync', 'openSync', 'readSync', 'closeSync']) {
    Object.defineProperty(throwingReadFs, key, { get() { throw new Error('private ' + key + ' getter'); } });
  }
  assert.doesNotThrow(() => findMatchingFiles({ root: 'root', match: /^x$/, fs: throwingFindFs }));
  assert.deepEqual(findMatchingFiles({ root: 'root', match: /^x$/, fs: throwingFindFs }), []);
  assert.doesNotThrow(() => readJsonlSample({ file: 'x', fs: throwingReadFs }));
  assert.equal(readJsonlSample({ file: 'x', fs: throwingReadFs }), null);
});

test('empty discovered logs with a failed open report LOCAL_LOG_UNREADABLE', () => {
  const root = tempDir();
  try {
    const sessions = path.join(root, 'sessions');
    const auth = path.join(root, 'auth.json');
    fs.mkdirSync(sessions);
    fs.writeFileSync(auth, JSON.stringify({ tokens: {} }));
    fs.writeFileSync(path.join(sessions, 'rollout-empty.jsonl'), '');
    const unreadableFs = Object.assign({}, fs, { openSync() { throw new Error('blocked'); } });
    const checks = createProviderChecks({ fs: unreadableFs, codexAuthPath: auth, codexSessionsRoot: sessions });
    for (const id of ['codex.sessions', 'codex.local-log']) {
      const result = checks.find((check) => check.id === id).run();
      assert.equal(result.status, 'fail');
      assert.equal(result.errorCode, 'LOCAL_LOG_UNREADABLE');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
