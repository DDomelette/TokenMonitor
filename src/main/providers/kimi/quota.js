// Kimi 账户额度采集:GET https://api.kimi.com/coding/v1/usages。
// 凭证只读(CLI 自己保活刷新,见 auth.js 头注);401 由上层判 expired。
const { readCred } = require('./auth');
const { makeQuotaState } = require('../types');

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

async function fetchQuota(ctx) {
  const cred = readCred();
  if (!cred || !cred.accessToken) return null;
  const headers = {
    'Authorization': 'Bearer ' + cred.accessToken,
    'User-Agent': 'kimi_cli'
  };
  const proxy = ctx.getProxyUrl() || null;
  const data = await ctx.httpGet('https://api.kimi.com/coding/v1/usages', headers, proxy);
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

module.exports = { normalizeKimiUsage, fetchQuota, windowKind };
