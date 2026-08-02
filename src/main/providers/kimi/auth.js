// Kimi 凭证:复用 ~/.kimi-code/credentials/kimi-code.json,临期时用 refresh_token 自刷新并原子回写。
// 刷新机制(2026-08 重新调查,kimi.exe 内嵌 oauth 模块):
//   POST https://auth.kimi.com/api/oauth/token (form: client_id / grant_type=refresh_token / refresh_token)
//   响应含新 access_token + 轮换的 refresh_token + expires_in(900s),必须回写否则 refresh_token 失效。
//   刷新阈值与 CLI 一致:max(300s, expires_in*0.5) = 450s。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpPostForm } = require('../../core/http');

const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const TOKEN_URL = 'https://auth.kimi.com/api/oauth/token';
const REFRESH_THRESHOLD_MS = 450 * 1000;
const DEFAULT_CRED_PATH = () => path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json');

// 每次调用重读文件(kimi CLI 登录后回写)。
function readCred(credPath) {
  const p = credPath || DEFAULT_CRED_PATH();
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      accessToken: data.access_token || null,
      refreshToken: data.refresh_token || null,
      expiresAt: data.expires_at ? Number(data.expires_at) * 1000 : null,
      scope: data.scope || null,
      credPath: p
    };
  } catch (e) {
    return null;
  }
}

function isExpired(cred) {
  return cred && cred.expiresAt ? cred.expiresAt - Date.now() < 5 * 60 * 1000 : false;
}

// 距过期不足阈值且持有 refresh_token 时才需要刷新
function needsRefresh(cred) {
  return !!(cred && cred.refreshToken && cred.expiresAt && cred.expiresAt - Date.now() < REFRESH_THRESHOLD_MS);
}

// 用 refresh_token 换新 token 并原子回写凭证文件(保留其余字段;refresh_token 会轮换)。
// 401/403 由 httpPostForm reject("Unauthorized: ..."),其余失败同样向上抛,调用方回退旧 token。
async function refreshCred(ctx, cred) {
  if (!cred || !cred.refreshToken) return null;
  const proxy = ctx && typeof ctx.getProxyUrl === 'function' ? ctx.getProxyUrl() : null;
  const data = await httpPostForm(TOKEN_URL, {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: cred.refreshToken
  }, { 'User-Agent': 'kimi-code-cli' }, proxy);
  if (!data || !data.access_token) return null;
  const expiresIn = Number(data.expires_in) || 900;
  try {
    const raw = JSON.parse(fs.readFileSync(cred.credPath, 'utf8'));
    raw.access_token = data.access_token;
    if (data.refresh_token) raw.refresh_token = data.refresh_token;
    if (data.scope) raw.scope = data.scope;
    if (data.token_type) raw.token_type = data.token_type;
    raw.expires_in = expiresIn;
    raw.expires_at = Math.floor(Date.now() / 1000) + expiresIn;
    const tmp = cred.credPath + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
    fs.renameSync(tmp, cred.credPath);
  } catch (e) {
    return null;
  }
  return readCred(cred.credPath);
}

// 临期则刷新并回写;刷新失败返回原值(未硬过期仍可用),由上层据 401/isExpired 判 expired。
async function ensureFresh(ctx, credPath) {
  const cred = readCred(credPath);
  if (!cred || !needsRefresh(cred)) return cred;
  try {
    const refreshed = await refreshCred(ctx, cred);
    return refreshed || cred;
  } catch (e) {
    return cred;
  }
}

module.exports = { readCred, ensureFresh, refreshCred, isExpired, needsRefresh, CLIENT_ID, TOKEN_URL, DEFAULT_CRED_PATH };
