// Kimi 账户额度采集:GET https://api.kimi.com/coding/v1/usages。
// 凭证只读(CLI 自己保活刷新,见 auth.js 头注);401 由上层判 expired。
const { readCred, isExpired } = require('./auth');
const { makeQuotaState } = require('../types');

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

async function fetchQuota(ctx) {
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

module.exports = { normalizeKimiUsage, fetchQuota, windowKind, classifyAuthFailure };
