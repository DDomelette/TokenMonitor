// MCP Bearer token:启动时确保存在,支持轮换。凭证只经本模块读写 store。
const crypto = require('node:crypto');

const TOKEN_KEY = 'mcp.token';

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function ensureMcpToken(store) {
  const existing = store.get(TOKEN_KEY);
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const token = generateToken();
  store.set(TOKEN_KEY, token);
  return token;
}

function rotateMcpToken(store) {
  const token = generateToken();
  store.set(TOKEN_KEY, token);
  return token;
}

module.exports = { ensureMcpToken, rotateMcpToken, TOKEN_KEY };
