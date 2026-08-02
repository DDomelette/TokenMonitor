// Codex 账户额度采集:GET https://chatgpt.com/backend-api/wham/usage(需代理)。
const { ensureFresh } = require('./auth');
const { makeQuotaState } = require('../types');

// windows 换算规则:18000s→'5h',604800s→'weekly',其他按秒数推断为 'limit'。
function windowKind(seconds) {
  if (seconds === 18000) return '5h';
  if (seconds === 604800) return 'weekly';
  return 'limit';
}

// used_percent 语义(用户已核实):即"剩余百分比"。limit 归一为 100。
function mapWindow(w) {
  const remaining = Number(w.used_percent) || 0;
  const limit = 100;
  let resetsAt = null;
  if (w.reset_at) resetsAt = Number(w.reset_at) * 1000;
  else if (w.reset_after_seconds) resetsAt = Date.now() + Number(w.reset_after_seconds) * 1000;
  else resetsAt = Date.now();
  return {
    kind: windowKind(Number(w.limit_window_seconds)),
    used: Math.max(0, limit - remaining),
    limit: limit,
    remaining: remaining,
    resetsAt: resetsAt
  };
}

// 归一化 wham/usage 响应(纯函数)。处理 secondary_window:null、additional_rate_limits[] 合并进 windows。
function normalizeWhamUsage(data) {
  const windows = [];
  const rate = data && data.rate_limit;
  if (rate && rate.primary_window) windows.push(mapWindow(rate.primary_window));
  if (rate && rate.secondary_window) windows.push(mapWindow(rate.secondary_window));
  ((data && data.additional_rate_limits) || []).forEach(function (limit) {
    if (limit && limit.rate_limit && limit.rate_limit.primary_window) {
      windows.push(mapWindow(limit.rate_limit.primary_window));
    }
  });

  let balance = null;
  if (data && data.credits && data.credits.has_credits) {
    balance = { total: Number(data.credits.balance) || 0, granted: null, toppedUp: null, currency: 'USD' };
  }

  return makeQuotaState(
    'codex',
    'subscription',
    windows,
    balance,
    (data && data.plan_type) || null,
    null,
    Date.now()
  );
}

async function fetchQuota(ctx) {
  const auth = await ensureFresh(ctx);
  if (!auth || !auth.accessToken) return null;
  const data = await ctx.httpGet('https://chatgpt.com/backend-api/wham/usage', {
    'Authorization': 'Bearer ' + auth.accessToken,
    'ChatGPT-Account-Id': auth.accountId,
    'User-Agent': 'codex_cli_rs/0.46.0'
  }, ctx.getProxyUrl());
  return normalizeWhamUsage(data);
}

module.exports = { normalizeWhamUsage, fetchQuota, mapWindow, windowKind };
