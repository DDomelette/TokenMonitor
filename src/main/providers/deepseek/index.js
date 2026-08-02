// DeepSeek Provider 适配器:组装 usage/balance/session/proxy,对外暴露统一 ProviderAdapter 接口。
const { UsageFetcher } = require('./usage');
const { fetchBalance } = require('./balance');

const fetcher = new UsageFetcher();

module.exports = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  capabilities: { balance: true, webUsage: true, quota: false, localLog: false, realtimeProxy: true },

  authStatus(ctx) {
    return ctx.store.get('providers.deepseek.sessionToken') ? 'ok' : 'missing';
  },

  // 可选:余额(预付制)。
  fetchBalance(ctx) {
    const apiKey = ctx.store.get('providers.deepseek.apiKey');
    if (!apiKey) return Promise.resolve(null);
    return fetchBalance(apiKey);
  },

  // 可选:web 用量(保持 DeepSeek 现有返回形状 { cost, amount, month, year, fellBack })。
  fetchUsage(ctx, { month, year }) {
    const token = ctx.store.get('providers.deepseek.sessionToken');
    if (!token) return Promise.resolve(null);
    return fetcher.fetchUsageWithFallback(token, month, year);
  }

  // quota: 无(预付制,额度即余额)
  // readLocalLog: 无(平台侧日志不落本机)
};
