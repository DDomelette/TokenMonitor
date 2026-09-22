// Kimi Provider 适配器(accountQuota 通道 + localLog 通道)。
const { fetchQuota } = require('./quota');
const { readCred, isExpired } = require('./auth');
const { readWebTokens } = require('./web-session');
const { readLocalLog, DEFAULT_ROOT } = require('./locallog');

module.exports = {
  id: 'kimi',
  displayName: 'Kimi',
  capabilities: { balance: false, webUsage: false, quota: true, localLog: true, realtimeProxy: false },

  // 额度门禁:已登录网页(web token 在库,自动刷新)即视为可用,与 CLI 凭证无关;
  // 未登录网页才看 CLI 凭证文件。
  authStatus(ctx) {
    if (ctx && ctx.store && readWebTokens(ctx.store)) return 'ok';
    const cred = readCred();
    if (!cred || !cred.accessToken) return 'missing';
    if (isExpired(cred)) return 'expired';
    return 'ok';
  },

  fetchQuota,

  localLogRoot(ctx) {
    return (ctx && ctx.store && ctx.store.get('providers.kimi.localLogRoot')) || DEFAULT_ROOT();
  },

  readLocalLog
};
