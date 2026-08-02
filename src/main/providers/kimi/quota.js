// Kimi 账户额度采集:GET https://api.kimi.com/coding/v1/usages。
const { ensureFresh } = require('./auth');
const { makeQuotaState } = require('../types');

// 判定规则:limits[i].window.duration===300 && timeUnit==='TIME_UNIT_MINUTE' → '5h';顶层 usage → 'weekly'。
function windowKind(duration, timeUnit) {
  return Number(duration) === 300 && timeUnit === 'TIME_UNIT_MINUTE' ? '5h' : 'weekly';
}

function normalizeKimiUsage(data) {
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
    (data && (data.plan_name || data.planName)) || null,
    null,
    Date.now()
  );
}

async function fetchQuota(ctx) {
  const cred = await ensureFresh(ctx);
  if (!cred || !cred.accessToken) return null;
  const data = await ctx.httpGet('https://api.kimi.com/coding/v1/usages', {
    'Authorization': 'Bearer ' + cred.accessToken,
    'User-Agent': 'kimi_cli'
  }, ctx.getProxyUrl() || null);
  return normalizeKimiUsage(data);
}

module.exports = { normalizeKimiUsage, fetchQuota, windowKind };
