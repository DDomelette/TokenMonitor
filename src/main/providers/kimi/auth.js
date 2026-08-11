// Kimi 凭证:只读复用 ~/.kimi-code/credentials/kimi-code.json,由 kimi CLI 自己保活刷新。
// (曾主动 refresh 并原子回写:refresh_token 一次性轮换,若抢在 CLI 前刷新成功,
//  CLI 内存中的旧 refresh_token 立即作废,表现为 CLI 连接失败/需重新登录——故改为只读。)
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CRED_PATH = () => path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json');

// 每次调用重读文件(kimi CLI 登录/刷新后回写)。
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

// 只有真正过期的 token 才判 expired。
// 只读模式下我们不自己刷新,由 CLI 刷新回写;若按旧的 5 分钟提前量预判,
// token 剩余<5min 且 CLI 尚未回写的空窗期会被误报"已过期"(API 实际仍可用),
// CLI 刷新后又自动恢复——表现为间歇性过期提示。真过期由 401 路径兜底判 expired。
function isExpired(cred) {
  return cred && cred.expiresAt ? cred.expiresAt <= Date.now() : false;
}

module.exports = { readCred, isExpired, DEFAULT_CRED_PATH };
