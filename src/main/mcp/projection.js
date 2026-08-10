// 把 scheduler 快照/usageDaily 投影为 MCP 对外安全 JSON(纯函数)。
// 数据源本身无凭证;返回前统一过 assertNoSecrets 兜底。

const SECRET_KEY_PATTERN = /apiKey|sessionToken|password|authorization/i;

function assertNoSecrets(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, path + '[' + i + ']'));
    return value;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach((key) => {
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new Error('projection 输出包含疑似凭证键: ' + path + '.' + key);
      }
      assertNoSecrets(value[key], path + '.' + key);
    });
  }
  return value;
}

function projectProviders(snapshot) {
  const out = (Array.isArray(snapshot) ? snapshot : []).map((p) => ({
    id: p.id,
    displayName: p.displayName,
    capabilities: p.capabilities || {},
    authStatus: p.authStatus || 'ok',
    stale: !!p.stale,
    quotaFetchedAt: p.quotaFetchedAt || null,
    lastFetchedAt: p.lastFetchedAt || null
  }));
  return assertNoSecrets(out, '$');
}

function projectRemainingUsage(snapshot, getState, provider) {
  const list = (Array.isArray(snapshot) ? snapshot : [])
    .filter((p) => !provider || p.id === provider)
    .map((p) => {
      const state = typeof getState === 'function' ? getState(p.id) : null;
      const rawBalance = state && state.balance;
      const quota = p.quota || null;
      return {
        id: p.id,
        displayName: p.displayName,
        billingMode: (quota && quota.billingMode) || null,
        balance: rawBalance ? {
          total: rawBalance.total ?? null,
          granted: rawBalance.granted ?? null,
          toppedUp: rawBalance.toppedUp ?? null,
          currency: rawBalance.currency ?? null
        } : null,
        windows: (quota && Array.isArray(quota.windows)) ? quota.windows : [],
        quotaFetchedAt: p.quotaFetchedAt || null,
        stale: !!p.stale,
        authStatus: p.authStatus || 'ok'
      };
    });
  return assertNoSecrets(list, '$');
}

// 按本地日历日取某日各 provider 的日聚合条目
function dailyEntries(usageDaily, date, provider) {
  const source = usageDaily && typeof usageDaily === 'object' ? usageDaily : {};
  const suffix = ':' + date;
  return Object.keys(source)
    .filter((k) => k.endsWith(suffix))
    .map((k) => ({ id: k.slice(0, k.length - suffix.length), entry: source[k] }))
    .filter((row) => !provider || row.id === provider);
}

function projectModelUsage(usageDaily, options) {
  const opts = options || {};
  const out = dailyEntries(usageDaily, opts.date, opts.provider).map((row) => {
    const models = Array.isArray(row.entry && row.entry.models) ? row.entry.models : [];
    const result = {
      id: row.id,
      models: models.map((m) => ({ model: m.model, tokens: Math.round(Number(m.tokens) || 0) }))
    };
    if (!result.models.length) result.note = 'provider 无模型级明细';
    return result;
  });
  return assertNoSecrets(out, '$');
}

function projectUsageSummary(usageDaily, options) {
  const opts = options || {};
  const out = dailyEntries(usageDaily, opts.date, opts.provider).map((row) => ({
    id: row.id,
    input: Math.round(Number(row.entry && row.entry.input) || 0),
    output: Math.round(Number(row.entry && row.entry.output) || 0),
    cached: Math.round(Number(row.entry && row.entry.cached) || 0),
    total: Math.round(Number(row.entry && row.entry.total) || 0)
  }));
  return assertNoSecrets(out, '$');
}

module.exports = {
  assertNoSecrets,
  projectProviders,
  projectRemainingUsage,
  projectModelUsage,
  projectUsageSummary
};
