// Kimi 凭证:只读复用 ~/.kimi-code/credentials/kimi-code.json(零改动原则)。
// Task 0 Spike 结论:刷新端点不可用(auth.kimi.com 全 404)→ 降级为"每次轮询重读文件 + expires_at 临期时由上层判 expired 引导 kimi login"。
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// 无可用刷新端点 → 仅重读;过期状态由 fetchQuota 401 / authStatus 判定。
function ensureFresh(ctx, credPath) {
  return readCred(credPath);
}

module.exports = { readCred, ensureFresh, isExpired, DEFAULT_CRED_PATH };
