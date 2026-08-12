// Codex Provider 适配器(accountQuota 通道 + localLog 通道)。
const { fetchQuota } = require('./quota');
const { readAuth, tokenExpiryMs } = require('./auth');
const { readLocalLog, DEFAULT_ROOT, DEFAULT_ARCHIVE_ROOT } = require('./locallog');
const { createCodexUsageRuntime } = require('./runtime');

module.exports = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: { balance: false, webUsage: false, quota: true, localLog: true, realtimeProxy: false },

  authStatus(ctx) {
    const auth = readAuth();
    if (!auth || !auth.accessToken) return 'missing';
    const exp = tokenExpiryMs(auth.accessToken);
    if (exp && exp - Date.now() < 5 * 60 * 1000) return 'expired';
    return 'ok';
  },

  fetchQuota,

  localLogRoot(ctx) {
    return (ctx && ctx.store && ctx.store.get('providers.codex.localLogRoot')) || DEFAULT_ROOT();
  },

  archivedLogRoot(ctx) {
    const store = ctx && ctx.store;
    const customActive = store && store.get('providers.codex.localLogRoot');
    const customArchive = store && store.get('providers.codex.archivedLogRoot');
    return customActive ? (customArchive || null) : (customArchive || DEFAULT_ARCHIVE_ROOT());
  },

  readLocalLog,

  createCodexUsageRuntime
};
