// Kimi Provider 适配器(accountQuota 通道 + localLog 通道(Task 6 接入))。
const { fetchQuota } = require('./quota');
const { readCred, isExpired } = require('./auth');

module.exports = {
  id: 'kimi',
  displayName: 'Kimi',
  capabilities: { balance: false, webUsage: false, quota: true, localLog: true, realtimeProxy: false },

  authStatus(ctx) {
    const cred = readCred();
    if (!cred || !cred.accessToken) return 'missing';
    if (isExpired(cred)) return 'expired';
    return 'ok';
  },

  fetchQuota

  // readLocalLog: Task 6 接入
};
