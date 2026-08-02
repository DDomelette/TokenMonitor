// Codex 凭证:只读复用 ~/.codex/auth.json(零改动原则)。
// refresh 端点来自 Task 0 Spike 验证:POST https://auth.openai.com/oauth/token(JSON,client_id app_EMoamEEZ73f0CkXaXp7hrann)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpPostJson } = require('../../core/http');

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_AUTH_PATH = () => path.join(os.homedir(), '.codex', 'auth.json');

// 每次调用重读文件(CLI 活跃时会自行刷新并回写)。
function readAuth(authPath) {
  const p = authPath || DEFAULT_AUTH_PATH();
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const tokens = data.tokens || {};
    return {
      accessToken: tokens.access_token || null,
      accountId: tokens.account_id || null,
      idToken: tokens.id_token || null,
      refreshToken: tokens.refresh_token || null,
      lastRefresh: data.last_refresh || null,
      authPath: p
    };
  } catch (e) {
    return null;
  }
}

// 从 JWT payload 解 exp(秒)。非 JWT 或解析失败返回 null。
function tokenExpiryMs(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch (e) {
    return null;
  }
}

// 用 refresh_token 换新 access_token 并回写 auth.json(保留其余字段)。
async function refreshAuth(ctx, auth) {
  if (!auth || !auth.refreshToken) return null;
  const proxy = ctx && typeof ctx.getProxyUrl === 'function' ? ctx.getProxyUrl() : null;
  const data = await httpPostJson(TOKEN_URL, {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken
  }, { 'User-Agent': 'codex_cli_rs/0.46.0' }, proxy);
  if (!data || !data.access_token) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(auth.authPath, 'utf8'));
    raw.tokens = raw.tokens || {};
    raw.tokens.access_token = data.access_token;
    if (data.refresh_token) raw.tokens.refresh_token = data.refresh_token;
    raw.last_refresh = new Date().toISOString();
    fs.writeFileSync(auth.authPath, JSON.stringify(raw, null, 2));
  } catch (e) {
    return null;
  }
  return readAuth(auth.authPath);
}

// 过期(距 exp < 5 分钟)则刷新并回写;刷新失败或不可用返回原值,由上层据 401 判 expired。
async function ensureFresh(ctx, authPath) {
  const auth = readAuth(authPath);
  if (!auth || !auth.accessToken) return auth;
  const exp = tokenExpiryMs(auth.accessToken);
  if (exp && exp - Date.now() > 5 * 60 * 1000) return auth;
  try {
    const refreshed = await refreshAuth(ctx, auth);
    return refreshed || auth;
  } catch (e) {
    return auth;
  }
}

module.exports = { readAuth, ensureFresh, refreshAuth, tokenExpiryMs, CLIENT_ID, TOKEN_URL, DEFAULT_AUTH_PATH };
