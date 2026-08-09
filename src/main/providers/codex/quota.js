// Codex 账户额度采集:GET https://chatgpt.com/backend-api/wham/usage(需代理)。
// 凭证只读(CLI 自己保活刷新,见 auth.js 头注);401 由上层判 expired。
const { readAuth } = require('./auth');
const { makeQuotaState } = require('../types');

// windows 换算规则:18000s→'5h',604800s→'weekly',其他按秒数推断为 'limit'。
function windowKind(seconds) {
  if (seconds === 18000) return '5h';
  if (seconds === 604800) return 'weekly';
  return 'limit';
}

// used_percent 语义:即"已用百分比"。
// limit 归一为 100,剩余 = 100 - used_percent。
// (曾按"剩余"理解,会导致未使用的窗口被误显示为耗尽斜纹条)
// name 保留限额名称(如 additional_rate_limits 的 "GPT-5.3-Codex-Spark"),主窗口为 null。
function mapWindow(w, name) {
  const used = Math.min(100, Math.max(0, Number(w.used_percent) || 0));
  const limit = 100;
  let resetsAt = null;
  if (w.reset_at) resetsAt = Number(w.reset_at) * 1000;
  else if (w.reset_after_seconds) resetsAt = Date.now() + Number(w.reset_after_seconds) * 1000;
  else resetsAt = Date.now();
  return {
    kind: windowKind(Number(w.limit_window_seconds)),
    name: name || null,
    used: used,
    limit: limit,
    remaining: limit - used,
    resetsAt: resetsAt
  };
}

// 归一化 wham/usage 响应(纯函数)。处理 secondary_window:null、additional_rate_limits[] 合并进 windows(保留 limit_name)。
function normalizeWhamUsage(data) {
  const windows = [];
  const rate = data && data.rate_limit;
  if (rate && rate.primary_window) windows.push(mapWindow(rate.primary_window));
  if (rate && rate.secondary_window) windows.push(mapWindow(rate.secondary_window));
  ((data && data.additional_rate_limits) || []).forEach(function (limit) {
    if (limit && limit.rate_limit && limit.rate_limit.primary_window) {
      windows.push(mapWindow(limit.rate_limit.primary_window, limit.limit_name));
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
  const auth = readAuth();
  if (!auth || !auth.accessToken) return null;
  const data = await ctx.httpGet('https://chatgpt.com/backend-api/wham/usage', {
    'Authorization': 'Bearer ' + auth.accessToken,
    'ChatGPT-Account-Id': auth.accountId,
    'User-Agent': 'codex_cli_rs/0.46.0'
  }, ctx.getProxyUrl());
  return normalizeWhamUsage(data);
}

module.exports = { normalizeWhamUsage, fetchQuota, mapWindow, windowKind };
