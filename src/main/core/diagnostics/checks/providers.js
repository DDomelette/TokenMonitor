const fs = require('node:fs');
const path = require('node:path');
const { fetchBalance: defaultFetchBalance } = require('../../../providers/deepseek/balance');
const { UsageFetcher: DefaultUsageFetcher } = require('../../../providers/deepseek/usage');
const { tokenExpiryMs: defaultTokenExpiryMs, DEFAULT_AUTH_PATH } = require('../../../providers/codex/auth');
const { parseRolloutLine, DEFAULT_ROOT: defaultCodexRoot, MATCH: codexMatch } = require('../../../providers/codex/locallog');
const { DEFAULT_CRED_PATH } = require('../../../providers/kimi/auth');
const { parseWireLine, DEFAULT_ROOT: defaultKimiRoot, MATCH: kimiMatch } = require('../../../providers/kimi/locallog');
const { findMatchingFiles, readJsonlSample } = require('../readonly-log');
const { httpGet: defaultHttpGet } = require('../../../core/http');

const LOCAL_TIMEOUT_MS = 8000;
const REMOTE_TIMEOUT_MS = 12000;
const EXPIRY_NEAR_MS = 5 * 60 * 1000;

function definition(id, title, guideId, phase, timeoutMs, run) {
  return { id, group: 'Providers', title, guideId, phase, timeoutMs, run };
}

function safeDependency(dependencies, key, fallback) {
  try {
    const value = dependencies && typeof dependencies === 'object' ? dependencies[key] : undefined;
    return value === undefined ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function consumeThenable(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try {
    const then = value.then;
    if (typeof then !== 'function') return false;
    then.call(value, () => {}, () => {});
    return true;
  } catch (_) {
    // An asynchronous value is never valid for synchronous configuration.
    return true;
  }
}

function safeStoreValue(store, key) {
  try {
    const get = store && typeof store.get === 'function' ? store.get : null;
    return get ? get.call(store, key) : undefined;
  } catch (_) {
    return undefined;
  }
}

function safeSynchronousStoreValue(store, key) {
  const value = safeStoreValue(store, key);
  return consumeThenable(value) ? undefined : value;
}

async function safeConfiguredValue(dependencies, getterKey, storeKey) {
  try {
    const getter = safeDependency(dependencies, getterKey, null);
    const value = typeof getter === 'function'
      ? getter()
      : safeStoreValue(safeDependency(dependencies, 'store', null), storeKey);
    return await value;
  } catch (_) {
    return undefined;
  }
}

function safePath(value, fallback) {
  if (typeof value === 'string' && value) return value;
  try { return typeof fallback === 'function' ? fallback() : ''; } catch (_) { return ''; }
}

function expiryClass(expiry, now) {
  if (!Number.isFinite(expiry)) return 'unknown';
  if (expiry <= now) return 'expired';
  if (expiry - now <= EXPIRY_NEAR_MS) return 'near-expiry';
  return 'valid';
}

function safeNow(now) {
  try {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  } catch (_) {
    return Date.now();
  }
}

function validExpirySeconds(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : null;
}

function readJsonSnapshot(fsApi, file) {
  try {
    const bytes = fsApi.readFileSync(file);
    const raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch (_) {
    return null;
  }
}

async function safeProxy(dependencies) {
  try {
    const getProxyUrl = safeDependency(dependencies, 'getProxyUrl', null);
    if (typeof getProxyUrl === 'function') return (await getProxyUrl()) || null;
  } catch (_) {
    return null;
  }
  try {
    return (await safeStoreValue(safeDependency(dependencies, 'store', null), 'providers.proxyUrl')) || null;
  } catch (_) {
    return null;
  }
}

function sessionResult(root, match, fsApi, pathApi) {
  const files = findMatchingFiles({ root, match, fs: fsApi, path: pathApi });
  if (!files.length) {
      return { status: 'fail', summary: 'No readable local session log was found', errorCode: 'LOCAL_LOG_NOT_FOUND', metadata: { matchingFiles: 0 } };
  }
  if (readJsonlSample({ file: files[0], fs: fsApi }) === null) {
    return { status: 'fail', summary: 'Local session log is unreadable', errorCode: 'LOCAL_LOG_UNREADABLE', metadata: { matchingFiles: files.length } };
  }
  return { status: 'pass', summary: 'Local session logs are readable', metadata: { matchingFiles: files.length } };
}

function localLogResult(root, match, parser, fsApi, pathApi) {
  const files = findMatchingFiles({ root, match, fs: fsApi, path: pathApi });
  if (!files.length) {
    return { status: 'fail', summary: 'No readable local session log was found', errorCode: 'LOCAL_LOG_NOT_FOUND', metadata: { matchingFiles: 0, sampledLines: 0, parsedRecords: 0 } };
  }
  const lines = readJsonlSample({ file: files[0], fs: fsApi });
  if (lines === null) {
    return { status: 'fail', summary: 'Local log sample could not be read safely', errorCode: 'LOCAL_LOG_UNREADABLE', metadata: { matchingFiles: files.length, sampledLines: 0, parsedRecords: 0 } };
  }
  let parsedRecords = 0;
  try {
    for (const line of lines) if (typeof parser === 'function' && parser(line)) parsedRecords += 1;
  } catch (_) {
    return { status: 'fail', summary: 'Local log sample could not be parsed safely', errorCode: 'LOCAL_LOG_PARSE_FAILED', metadata: { matchingFiles: files.length, sampledLines: lines.length, parsedRecords: 0 } };
  }
  return {
    status: 'pass',
    summary: 'Local log sample was read without advancing a cursor',
    metadata: { matchingFiles: files.length, sampledLines: lines.length, parsedRecords }
  };
}

function quotaFailure() {
  return { status: 'fail', summary: 'Provider quota endpoint request failed', errorCode: 'QUOTA_REQUEST_FAILED' };
}

function createProviderChecks(dependencies = {}) {
  const deps = dependencies && typeof dependencies === 'object' ? dependencies : {};
  const fsApi = safeDependency(deps, 'fs', fs) || fs;
  const pathApi = safeDependency(deps, 'path', path) || path;
  const now = typeof safeDependency(deps, 'now', null) === 'function' ? safeDependency(deps, 'now', null) : Date.now;
  const fetchBalance = typeof safeDependency(deps, 'fetchBalance', null) === 'function' ? safeDependency(deps, 'fetchBalance', null) : defaultFetchBalance;
  const UsageFetcher = typeof safeDependency(deps, 'UsageFetcher', null) === 'function' ? safeDependency(deps, 'UsageFetcher', null) : DefaultUsageFetcher;
  const httpGet = typeof safeDependency(deps, 'httpGet', null) === 'function' ? safeDependency(deps, 'httpGet', null) : defaultHttpGet;
  const tokenExpiryMs = typeof safeDependency(deps, 'tokenExpiryMs', null) === 'function' ? safeDependency(deps, 'tokenExpiryMs', null) : defaultTokenExpiryMs;
  const store = safeDependency(deps, 'store', null);
  const codexAuthPath = safePath(safeDependency(deps, 'codexAuthPath', undefined), DEFAULT_AUTH_PATH);
  const codexSessionsRoot = safePath(safeDependency(deps, 'codexSessionsRoot', undefined) || safeSynchronousStoreValue(store, 'providers.codex.localLogRoot'), defaultCodexRoot);
  const kimiCredPath = safePath(safeDependency(deps, 'kimiCredPath', undefined), DEFAULT_CRED_PATH);
  const kimiSessionsRoot = safePath(safeDependency(deps, 'kimiSessionsRoot', undefined) || safeSynchronousStoreValue(store, 'providers.kimi.localLogRoot'), defaultKimiRoot);

  function deepseekApiKey() {
    return safeConfiguredValue(deps, 'getDeepseekApiKey', 'providers.deepseek.apiKey');
  }
  function deepseekSession() {
    return safeConfiguredValue(deps, 'getDeepseekSessionToken', 'providers.deepseek.sessionToken');
  }
  function codexSnapshot() {
    const raw = readJsonSnapshot(fsApi, codexAuthPath);
    const tokens = raw && raw.tokens && typeof raw.tokens === 'object' ? raw.tokens : null;
    if (!tokens) return null;
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : '';
    let expiry = null;
    try { expiry = tokenExpiryMs(accessToken); } catch (_) { expiry = null; }
    return {
      hasAccessToken: !!accessToken,
      hasRefreshToken: typeof tokens.refresh_token === 'string' && !!tokens.refresh_token,
      hasAccountId: typeof tokens.account_id === 'string' && !!tokens.account_id,
      accessToken,
      accountId: typeof tokens.account_id === 'string' ? tokens.account_id : '',
      expiry: expiryClass(expiry, safeNow(now))
    };
  }
  function kimiSnapshot() {
    const raw = readJsonSnapshot(fsApi, kimiCredPath);
    if (!raw) return null;
    const accessToken = typeof raw.access_token === 'string' ? raw.access_token : '';
    const seconds = validExpirySeconds(raw.expires_at);
    return {
      hasAccessToken: !!accessToken,
      hasRefreshToken: typeof raw.refresh_token === 'string' && !!raw.refresh_token,
      accessToken,
      expiry: expiryClass(seconds === null ? null : seconds * 1000, safeNow(now))
    };
  }

  return [
    definition('deepseek.api-key', 'DeepSeek API key', 'deepseek-api-key', 'remote', REMOTE_TIMEOUT_MS, async () => {
      let key;
      try { key = await deepseekApiKey(); } catch (_) { key = null; }
      if (typeof key !== 'string' || !key) return { status: 'skipped', summary: 'DeepSeek API key is not configured', metadata: { configured: false } };
      try {
        await fetchBalance(key, { httpGet, proxyUrl: await safeProxy(deps) });
        return { status: 'pass', summary: 'DeepSeek API key was accepted', metadata: { configured: true } };
      } catch (_) {
        return { status: 'fail', summary: 'DeepSeek API key check failed', errorCode: 'DEEPSEEK_API_KEY_FAILED', metadata: { configured: true } };
      }
    }),
    definition('deepseek.session', 'DeepSeek platform session', 'deepseek-session', 'remote', REMOTE_TIMEOUT_MS, async () => {
      let token;
      try { token = await deepseekSession(); } catch (_) { token = null; }
      if (typeof token !== 'string' || !token) return { status: 'skipped', summary: 'DeepSeek platform session is not configured', metadata: { configured: false } };
      try {
        const date = new Date(safeNow(now));
        const fetcher = new UsageFetcher();
        await fetcher.fetchUsageAmount(token, date.getMonth() + 1, date.getFullYear(), { httpGet, proxyUrl: await safeProxy(deps) });
        return { status: 'pass', summary: 'DeepSeek platform session was accepted', metadata: { configured: true } };
      } catch (_) {
        return { status: 'fail', summary: 'DeepSeek platform session check failed', errorCode: 'DEEPSEEK_SESSION_FAILED', metadata: { configured: true } };
      }
    }),
    definition('codex.auth', 'Codex credential snapshot', 'codex-auth', 'local', LOCAL_TIMEOUT_MS, () => {
      const snapshot = codexSnapshot();
      if (!snapshot) return { status: 'fail', summary: 'Codex credential file is unreadable', errorCode: 'CODEX_AUTH_UNREADABLE', metadata: { configured: false } };
      return { status: 'pass', summary: 'Codex credential file is readable', metadata: { configured: snapshot.hasAccessToken, hasRefreshToken: snapshot.hasRefreshToken, hasAccountId: snapshot.hasAccountId, expiry: snapshot.expiry } };
    }),
    definition('codex.sessions', 'Codex local sessions', 'codex-local-log', 'local', LOCAL_TIMEOUT_MS, () => sessionResult(codexSessionsRoot, codexMatch, fsApi, pathApi)),
    definition('codex.local-log', 'Codex local log sample', 'codex-local-log', 'local', LOCAL_TIMEOUT_MS, () => localLogResult(codexSessionsRoot, codexMatch, safeDependency(deps, 'parseRolloutLine', null) || parseRolloutLine, fsApi, pathApi)),
    definition('codex.quota', 'Codex quota endpoint', 'codex-auth', 'remote', REMOTE_TIMEOUT_MS, async () => {
      const snapshot = codexSnapshot();
      if (!snapshot || !snapshot.hasAccessToken) return { status: 'skipped', summary: 'Codex access token is not configured', metadata: { credentialState: 'missing' } };
      if (snapshot.expiry !== 'valid') return { status: 'skipped', summary: 'Codex access token is not valid for a read-only quota request', metadata: { credentialState: snapshot.expiry } };
      try {
        await httpGet('https://chatgpt.com/backend-api/wham/usage', {
          Authorization: 'Bearer ' + snapshot.accessToken,
          'ChatGPT-Account-Id': snapshot.accountId,
          'User-Agent': 'codex_cli_rs/0.46.0'
        }, await safeProxy(deps));
        return { status: 'pass', summary: 'Codex quota endpoint responded', metadata: { credentialState: 'valid' } };
      } catch (_) { return quotaFailure(); }
    }),
    definition('kimi.auth', 'Kimi credential snapshot', 'kimi-auth', 'local', LOCAL_TIMEOUT_MS, () => {
      const snapshot = kimiSnapshot();
      if (!snapshot) return { status: 'fail', summary: 'Kimi credential file is unreadable', errorCode: 'KIMI_AUTH_UNREADABLE', metadata: { configured: false } };
      return { status: 'pass', summary: 'Kimi credential file is readable', metadata: { configured: snapshot.hasAccessToken, hasRefreshToken: snapshot.hasRefreshToken, expiry: snapshot.expiry } };
    }),
    definition('kimi.sessions', 'Kimi local sessions', 'kimi-local-log', 'local', LOCAL_TIMEOUT_MS, () => sessionResult(kimiSessionsRoot, kimiMatch, fsApi, pathApi)),
    definition('kimi.local-log', 'Kimi local log sample', 'kimi-local-log', 'local', LOCAL_TIMEOUT_MS, () => localLogResult(kimiSessionsRoot, kimiMatch, safeDependency(deps, 'parseWireLine', null) || parseWireLine, fsApi, pathApi)),
    definition('kimi.quota', 'Kimi quota endpoint', 'kimi-auth', 'remote', REMOTE_TIMEOUT_MS, async () => {
      const snapshot = kimiSnapshot();
      if (!snapshot || !snapshot.hasAccessToken) return { status: 'skipped', summary: 'Kimi access token is not configured', metadata: { credentialState: 'missing' } };
      if (snapshot.expiry !== 'valid') return { status: 'skipped', summary: 'Kimi access token is not valid for a read-only quota request', metadata: { credentialState: snapshot.expiry } };
      try {
        await httpGet('https://api.kimi.com/coding/v1/usages', {
          Authorization: 'Bearer ' + snapshot.accessToken,
          'User-Agent': 'kimi_cli'
        }, await safeProxy(deps));
        return { status: 'pass', summary: 'Kimi quota endpoint responded', metadata: { credentialState: 'valid' } };
      } catch (_) { return quotaFailure(); }
    })
  ];
}

module.exports = { createProviderChecks };
