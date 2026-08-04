// Codex 凭证:复用 ~/.codex/auth.json;刷新时通过同目录临时文件原子替换。
// refresh 端点来自 Task 0 Spike 验证:POST https://auth.openai.com/oauth/token(JSON,client_id app_EMoamEEZ73f0CkXaXp7hrann)。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpPostJson } = require('../../core/http');

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_AUTH_PATH = () => path.join(os.homedir(), '.codex', 'auth.json');
const authVersions = new WeakMap();

function contentVersion(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

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

function readAuthSnapshot(authPath) {
  const bytes = Buffer.from(fs.readFileSync(authPath));
  const raw = JSON.parse(bytes.toString('utf8'));
  const version = contentVersion(bytes);
  const auth = authFromRaw(raw, authPath);
  authVersions.set(auth, version);
  return { auth, raw, version };
}

// 每次调用重读文件(CLI 活跃时会自行刷新并回写),并把实际内容版本绑定到返回对象。
function readAuth(authPath) {
  const p = authPath || DEFAULT_AUTH_PATH();
  try {
    return readAuthSnapshot(p).auth;
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

function authFileMetadata(authPath) {
  const stat = fs.statSync(authPath);
  return {
    mode: stat.mode & 0o777,
    uid: Number.isInteger(stat.uid) ? stat.uid : null,
    gid: Number.isInteger(stat.gid) ? stat.gid : null
  };
}

function metadataError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function conflictError() {
  const error = new Error('CODEX_AUTH_CONFLICT');
  error.code = 'CODEX_AUTH_CONFLICT';
  return error;
}

function ownerMatches(stat, metadata) {
  return metadata.uid === null
    || metadata.gid === null
    || (stat.uid === metadata.uid && stat.gid === metadata.gid);
}

function applyTempMetadata(fd, metadata) {
  if (process.platform === 'win32') return;
  let stat = fs.fstatSync(fd);
  if (!ownerMatches(stat, metadata)) {
    fs.fchownSync(fd, metadata.uid, metadata.gid);
    stat = fs.fstatSync(fd);
  }
  fs.fchmodSync(fd, metadata.mode);
  stat = fs.fstatSync(fd);
  if ((stat.mode & 0o777) !== metadata.mode) {
    throw metadataError('CODEX_AUTH_MODE_MISMATCH');
  }
  if (!ownerMatches(stat, metadata)) {
    throw metadataError('CODEX_AUTH_OWNER_MISMATCH');
  }
}

function verifyTargetMetadata(authPath, metadata) {
  if (process.platform === 'win32') return;
  let stat = fs.statSync(authPath);
  if (!ownerMatches(stat, metadata)) {
    fs.chownSync(authPath, metadata.uid, metadata.gid);
    stat = fs.statSync(authPath);
  }
  if ((stat.mode & 0o777) !== metadata.mode) {
    fs.chmodSync(authPath, metadata.mode);
    stat = fs.statSync(authPath);
  }
  if ((stat.mode & 0o777) !== metadata.mode) {
    throw metadataError('CODEX_AUTH_MODE_MISMATCH');
  }
  if (!ownerMatches(stat, metadata)) {
    throw metadataError('CODEX_AUTH_OWNER_MISMATCH');
  }
}

function assertContentVersion(authPath, expectedVersion) {
  const currentVersion = contentVersion(Buffer.from(fs.readFileSync(authPath)));
  if (currentVersion !== expectedVersion) throw conflictError();
}

function writeAuthAtomic(authPath, raw, metadata, expectedVersion) {
  const tmp = authPath + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', metadata.mode);
    fs.writeFileSync(fd, JSON.stringify(raw, null, 2), 'utf8');
    applyTempMetadata(fd, metadata);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    // OAuth 调用完成后到原子替换前仍可能被 Codex CLI 更新,因此在 rename 紧邻位置再次比较实际内容。
    assertContentVersion(authPath, expectedVersion);
    fs.renameSync(tmp, authPath);
    verifyTargetMetadata(authPath, metadata);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) {}
    }
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
  }
}

function sameCredentialSnapshot(left, right) {
  return !!left && !!right
    && left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken
    && left.accountId === right.accountId
    && left.idToken === right.idToken;
}

function expectedVersionFor(auth) {
  const knownVersion = authVersions.get(auth);
  if (knownVersion) return { version: knownVersion, latest: null };

  // refreshAuth 仍是公开函数。对非 readAuth() 创建的对象,只在其凭证字段与当前磁盘快照一致时建立版本基线。
  const current = readAuthSnapshot(auth.authPath);
  if (!sameCredentialSnapshot(current.auth, auth)) {
    return { version: null, latest: current.auth };
  }
  return { version: current.version, latest: null };
}

// 用 refresh_token 换新 access_token 并原子回写 auth.json(保留其余字段)。
// 若外部 Codex CLI 在刷新期间修改文件,返回磁盘最新有效凭证且绝不覆盖。
async function refreshAuth(ctx, auth) {
  if (!auth || !auth.refreshToken) return null;

  let source;
  try {
    source = expectedVersionFor(auth);
  } catch (e) {
    return null;
  }
  if (source.latest) return source.latest;

  const proxy = ctx && typeof ctx.getProxyUrl === 'function' ? ctx.getProxyUrl() : null;
  const data = await httpPostJson(TOKEN_URL, {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken
  }, { 'User-Agent': 'codex_cli_rs/0.46.0' }, proxy);
  if (!data || !data.access_token) return null;

  try {
    const current = readAuthSnapshot(auth.authPath);
    if (current.version !== source.version) return current.auth;

    const metadata = authFileMetadata(auth.authPath);
    const raw = current.raw;
    raw.tokens = raw.tokens || {};
    raw.tokens.access_token = data.access_token;
    if (data.refresh_token) raw.tokens.refresh_token = data.refresh_token;
    raw.last_refresh = new Date().toISOString();
    writeAuthAtomic(auth.authPath, raw, metadata, source.version);
  } catch (e) {
    if (e && e.code === 'CODEX_AUTH_CONFLICT') return readAuth(auth.authPath);
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
