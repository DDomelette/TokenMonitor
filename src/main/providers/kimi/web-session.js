// Kimi 网页会话:捕获 kimi.com 网页端 localStorage 的 access_token/refresh_token,
// 用于读取网页侧月额度(MembershipService/GetSubscriptionStats,CLI usages 接口不含)。
// 与 CLI 凭证(kimi-code.json,HS512)完全独立:网页 access_token 是 ES256 JWT,
// 有效期约 15 分钟,由本模块用 refresh_token 自行刷新回写 store。
// 实测同一 refresh_token 可重复用于刷新(非一次性轮换),monitor 刷新不会踢掉网页端;
// 但刷新响应里的新 refreshToken 仍按要求回写。
const { BrowserWindow } = require('electron');
const { httpPostJson } = require('../../core/http');

const REFRESH_URL = 'https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken';
const STATS_URL = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats';
const KIMI_HOME = 'https://www.kimi.com/';
// access_token 剩余不足该时长即刷新(15 分钟有效期,60s 提前量覆盖一次轮询周期)
const REFRESH_AHEAD_MS = 60 * 1000;

// ES256 JWT 不过期字段不签名解析,只取 payload.exp(秒)转毫秒;解析失败返回 null(视为将过期,走刷新)。
function decodeJwtExpMs(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload && payload.exp ? Number(payload.exp) * 1000 : null;
  } catch (e) {
    return null;
  }
}

function readWebTokens(store) {
  const accessToken = store.get('providers.kimi.webAccessToken') || null;
  const refreshToken = store.get('providers.kimi.webRefreshToken') || null;
  if (!accessToken || !refreshToken) return null;
  const expiresAt = Number(store.get('providers.kimi.webAccessExpiresAt')) || null;
  return { accessToken: accessToken, refreshToken: refreshToken, expiresAt: expiresAt };
}

// tokens: { accessToken, refreshToken, expiresAt(ms|null) }
function writeWebTokens(store, tokens) {
  store.set('providers.kimi.webAccessToken', tokens.accessToken);
  store.set('providers.kimi.webRefreshToken', tokens.refreshToken);
  store.set('providers.kimi.webAccessExpiresAt', tokens.expiresAt || null);
  store.set('providers.kimi.webLinked', true);
}

function clearWebTokens(store) {
  store.delete('providers.kimi.webAccessToken');
  store.delete('providers.kimi.webRefreshToken');
  store.delete('providers.kimi.webAccessExpiresAt');
  store.set('providers.kimi.webLinked', false);
}

// 返回可用的网页 access_token;未登录返回 null。
// 过期/临期时用 refresh_token 调 RefreshToken 接口换新并回写;
// 刷新被拒(400/401/403,refresh_token 失效)清除网页凭证,等待用户重新登录;
// 其余失败(网络等)保留凭证,下周期重试。
async function ensureFreshWebToken(store, deps) {
  const tokens = readWebTokens(store);
  if (!tokens) return null;
  if (tokens.expiresAt && tokens.expiresAt - Date.now() > REFRESH_AHEAD_MS) {
    return tokens.accessToken;
  }
  const post = (deps && deps.httpPostJson) || httpPostJson;
  const logger = (deps && deps.logger) || console;
  const proxyUrl = deps && deps.proxyUrl ? deps.proxyUrl : null;
  let res;
  try {
    res = await post(REFRESH_URL, { refreshToken: tokens.refreshToken }, {}, proxyUrl);
  } catch (e) {
    const msg = (e && e.message) || '';
    if (/unauthoriz|\b400\b|\b401\b|\b403\b/i.test(msg)) {
      logger.error('[kimi-web] refresh token rejected, clearing web credentials:', msg);
      clearWebTokens(store);
    } else {
      logger.error('[kimi-web] token refresh failed (kept for retry):', msg);
    }
    return null;
  }
  const accessToken = res && res.accessToken;
  const refreshToken = (res && res.refreshToken) || tokens.refreshToken;
  if (!accessToken) {
    logger.error('[kimi-web] refresh response missing accessToken');
    return null;
  }
  writeWebTokens(store, {
    accessToken: accessToken,
    refreshToken: refreshToken,
    expiresAt: decodeJwtExpMs(accessToken)
  });
  return accessToken;
}

// GetSubscriptionStats.subscriptionBalance → monthly quota window;字段缺失返回 null。
function monthlyWindowFromStats(stats) {
  const bal = stats && stats.subscriptionBalance;
  if (!bal || bal.amountUsedRatio === undefined || bal.amountUsedRatio === null) return null;
  const ratio = Math.min(1, Math.max(0, Number(bal.amountUsedRatio) || 0));
  const resetsAt = bal.expireTime ? Date.parse(bal.expireTime) : NaN;
  return {
    kind: 'monthly',
    used: ratio * 100,
    limit: 100,
    remaining: (1 - ratio) * 100,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : Date.now()
  };
}

// 拉取订阅统计原文(ratelimitCode5h/ratelimitCode7d/subscriptionBalance);
// 未登录网页或刷新失败返回 null,HTTP 错误原样抛出(由调用方降级)。
async function fetchSubscriptionStats(ctx) {
  const store = ctx && ctx.store;
  if (!store) return null;
  const logger = (ctx && ctx.logger) || console;
  const proxyUrl = ctx && typeof ctx.getProxyUrl === 'function' ? ctx.getProxyUrl() : null;
  const post = (ctx && ctx.httpPostJson) || httpPostJson;
  let token;
  try {
    token = await ensureFreshWebToken(store, { httpPostJson: post, proxyUrl: proxyUrl, logger: logger });
  } catch (e) {
    logger.error('[kimi-web] ensureFreshWebToken failed:', (e && e.message) || e);
    return null;
  }
  if (!token) return null;
  return post(STATS_URL, {}, { Authorization: 'Bearer ' + token }, proxyUrl);
}

function createWebSessionWindow() {
  return new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    center: true,
    title: '登录 Kimi 网页(月额度)',
    webPreferences: {
      partition: 'persist:kimi-web',
      contextIsolation: true,
      nodeIntegration: false
    }
  });
}

// 打开 kimi.com 登录窗,轮询 localStorage 直到拿到 access_token+refresh_token;
// persist 分区保留登录态,已登录用户开窗即捕获。窗口被关且未捕获到则 reject。
function captureWebSession(ctx) {
  const logger = (ctx && ctx.logger) || console;
  return new Promise((resolve, reject) => {
    const win = ctx && typeof ctx.createWebSessionWindow === 'function'
      ? ctx.createWebSessionWindow()
      : createWebSessionWindow();
    let settled = false;
    const timer = setInterval(() => {
      if (settled || win.isDestroyed()) return;
      win.webContents.executeJavaScript(
        "(function(){try{var a=localStorage.getItem('access_token');var r=localStorage.getItem('refresh_token');"
        + "return (a&&r)?{accessToken:a,refreshToken:r}:null;}catch(e){return null;}})()",
        true
      ).then((tokens) => {
        if (settled || !tokens || !tokens.accessToken || !tokens.refreshToken) return;
        settled = true;
        clearInterval(timer);
        logger.log('[kimi-web] captured web session tokens');
        try { win.close(); } catch (e) {}
        resolve({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: decodeJwtExpMs(tokens.accessToken)
        });
      }).catch(() => { /* 页面未就绪/导航中,下轮再试 */ });
    }, 1000);

    win.on('closed', () => {
      clearInterval(timer);
      if (!settled) {
        settled = true;
        logger.log('[kimi-web] session window closed without tokens');
        reject(new Error('未捕获到 Kimi 网页会话'));
      }
    });

    win.loadURL(KIMI_HOME);
  });
}

module.exports = {
  REFRESH_URL,
  STATS_URL,
  decodeJwtExpMs,
  readWebTokens,
  writeWebTokens,
  clearWebTokens,
  ensureFreshWebToken,
  monthlyWindowFromStats,
  fetchSubscriptionStats,
  captureWebSession,
  createWebSessionWindow
};
