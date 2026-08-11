// Codex 凭证:只读复用 ~/.codex/auth.json,由 Codex CLI 自己保活刷新。
// (曾主动 refresh 并原子回写:refresh_token 一次性轮换,若抢在 CLI 前刷新成功,
//  CLI 内存中的旧 refresh_token 立即作废,表现为 CLI 连接失败/需重新登录——故改为只读。)
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_AUTH_PATH = () => path.join(os.homedir(), '.codex', 'auth.json');

function authFromRaw(raw, authPath) {
  const tokens = raw.tokens || {};
  return {
    accessToken: tokens.access_token || null,
    accountId: tokens.account_id || null,
    idToken: tokens.id_token || null,
    refreshToken: tokens.refresh_token || null,
    lastRefresh: raw.last_refresh || null,
    authPath
  };
}

// 每次调用重读文件(CLI 活跃时会自行刷新并回写)。
function readAuth(authPath) {
  const p = authPath || DEFAULT_AUTH_PATH();
  try {
    return authFromRaw(JSON.parse(fs.readFileSync(p, 'utf8')), p);
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

module.exports = { readAuth, tokenExpiryMs, DEFAULT_AUTH_PATH };
