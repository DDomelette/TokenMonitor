// Codex Provider 适配器(accountQuota 通道 + localLog 通道)。
const { fetchQuota } = require('./quota');
const { readAuth, tokenExpiryMs } = require('./auth');
const { readLocalLog } = require('./locallog');

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

  readLocalLog
};
