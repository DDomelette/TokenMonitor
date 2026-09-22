// Kimi 账户额度采集,双通道:
// - 网页通道(优先):web-session.js 的 GetSubscriptionStats 一次给出 5h/7d/月三窗口,
//   与 CLI 凭证完全无关,登录网页后"凭证已过期"不再出现;
//   失败抛非认证类错误(消息避开 scheduler.isAuthError 关键字):沿用旧数据 + stale,不闪过期卡。
// - CLI 通道(未登录网页时兜底):GET https://api.kimi.com/coding/v1/usages,凭证只读
//   (CLI 自己保活刷新,见 auth.js 头注);401 由上层判 expired。
const { readCred, isExpired } = require('./auth');
const { makeQuotaState } = require('../types');
const { fetchSubscriptionStats, readWebTokens, monthlyWindowFromStats } = require('./web-session');

// 401 时复核凭证文件,区分"真过期"与"CLI 刷新空窗":
// - 文件 token 已换新(CLI 刚轮转回写)或文件显示仍未过期 → rotating:
//   本次 401 只是撞上了 CLI 刷新的瞬间,下一周期自动恢复,不应闪"已过期"卡片;
// - 文件读不出(mid-write)同样按 rotating 处理(下一轮自愈);
// - 文件 token 也真过期(CLI 长时间未运行)→ expired:原样抛出,上层显示过期。
function classifyAuthFailure(usedCred, freshCred) {
  if (!freshCred || !freshCred.accessToken) return 'rotating';
  if (freshCred.accessToken !== (usedCred && usedCred.accessToken)) return 'rotating';
  if (!isExpired(freshCred)) return 'rotating';
  return 'expired';
}

// 判定规则:limits[i].window.duration===300 && timeUnit==='TIME_UNIT_MINUTE' → '5h';顶层 usage → 'weekly'。
function windowKind(duration, timeUnit) {
  return Number(duration) === 300 && timeUnit === 'TIME_UNIT_MINUTE' ? '5h' : 'weekly';
}

function normalizeKimiUsage(data, planName) {
  const windows = [];
  const top = data && data.usage;
  if (top) {
    windows.push({
      kind: 'weekly',
      used: Number(top.used) || 0,
      limit: Number(top.limit) || 0,
      remaining: Number(top.remaining) || 0,
      resetsAt: top.resetTime ? new Date(top.resetTime).getTime() : Date.now()
    });
  }
  ((data && data.limits) || []).forEach(function (limit) {
    const w = limit && limit.window;
    const d = limit && limit.detail;
    if (w && d) {
      windows.push({
        kind: windowKind(w.duration, w.timeUnit),
        used: Number(d.used) || 0,
        limit: Number(d.limit) || 0,
        remaining: Number(d.remaining) || 0,
        resetsAt: d.resetTime ? new Date(d.resetTime).getTime() : Date.now()
      });
    }
  });

  return makeQuotaState(
    'kimi',
    'subscription',
    windows,
    null,
    (planName || (data && (data.plan_name || data.planName))) || null,
    null,
    Date.now()
  );
}

// GetSubscriptionStats 的 ratelimitCodeXxx → 百分比窗口。
// proto3 JSON 省略 0 值字段:没有 ratio 即未使用(实测 5h 空闲时响应只有 enabled+resetTime)。
function ratioWindow(ratelimit, kind) {
  if (!ratelimit || ratelimit.enabled === false) return null;
  const ratio = Math.min(1, Math.max(0, Number(ratelimit.ratio) || 0));
  const resetsAt = ratelimit.resetTime ? Date.parse(ratelimit.resetTime) : NaN;
  return {
    kind: kind,
    used: ratio * 100,
    limit: 100,
    remaining: (1 - ratio) * 100,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : Date.now()
  };
}

// 网页统计原文 → quota state(weekly/5h/monthly 三窗口,与 CLI 通道的窗口顺序一致)。
// stats 不含套餐名,由调用方从上轮数据沿用。三窗口全缺返回 null(视为异常响应)。
function quotaStateFromWebStats(stats, planName) {
  if (!stats) return null;
  const windows = [];
  const weekly = ratioWindow(stats.ratelimitCode7d, 'weekly');
  if (weekly) windows.push(weekly);
  const fiveH = ratioWindow(stats.ratelimitCode5h, '5h');
  if (fiveH) windows.push(fiveH);
  const monthly = monthlyWindowFromStats(stats);
  if (monthly) windows.push(monthly);
  if (!windows.length) return null;
  return makeQuotaState('kimi', 'subscription', windows, null, planName || null, null, Date.now());
}

async function fetchQuota(ctx) {
  const logger = (ctx && ctx.logger) || console;
  const hasWebSession = !!(ctx && ctx.store && readWebTokens(ctx.store));

  if (hasWebSession) {
    // 网页通道:不触碰 CLI 凭证。失败只降级(上轮数据继续显示,标 stale),
    // 错误消息不得含 401/403/登录/expired/unauthoriz 等关键字(scheduler 据此判 expired)。
    let stats = null;
    try {
      stats = await fetchSubscriptionStats(ctx);
    } catch (e) {
      logger.error('[kimi] web quota fetch failed:', (e && e.message) || e);
    }
    if (stats) {
      const prev = ctx.store.get('providers.kimi.lastQuota');
      const prevPlan = prev && prev.quota && prev.quota.planName;
      const state = quotaStateFromWebStats(stats, prevPlan);
      if (state) return state;
      logger.error('[kimi] web stats had no usable windows');
    }
    throw new Error('Kimi 网页额度暂未更新,下个周期自动重试');
  }

  // CLI 通道(未登录网页时)
  const cred = readCred();
  if (!cred || !cred.accessToken) return null;
  const headers = {
    'Authorization': 'Bearer ' + cred.accessToken,
    'User-Agent': 'kimi_cli'
  };
  const proxy = ctx.getProxyUrl() || null;
  let data;
  try {
    data = await ctx.httpGet('https://api.kimi.com/coding/v1/usages', headers, proxy);
  } catch (e) {
    const msg = (e && e.message) || '';
    // 刷新空窗的 401 改抛非认证类错误:scheduler 只对认证错误置 expired,
    // 空窗错误只记 lastError,卡片不闪"已过期"(消息不得含 401/登录/expired 等关键字)
    if (/unauthoriz|\b401\b|\b403\b|invalid[ -]?token/i.test(msg)
      && classifyAuthFailure(cred, readCred()) === 'rotating') {
      throw new Error('Kimi 凭证刷新中,下个周期自动恢复');
    }
    throw e;
  }
  // usages 接口不带套餐名,补查 /me 的 user_level_name(如 Allegretto);失败不阻断额度显示。
  let planName = (data && (data.plan_name || data.planName)) || null;
  if (!planName) {
    try {
      const me = await ctx.httpGet('https://api.kimi.com/coding/v1/me', headers, proxy);
      planName = (me && (me.user_level_name || me.userLevelName)) || null;
    } catch (e) { /* 套餐名缺失可容忍 */ }
  }
  return normalizeKimiUsage(data, planName);
}

module.exports = { normalizeKimiUsage, fetchQuota, windowKind, classifyAuthFailure, quotaStateFromWebStats };
