// Kimi 凭证:复用 ~/.kimi-code/credentials/kimi-code.json,临期时用 refresh_token 自刷新并原子回写。
// 刷新机制(2026-08 重新调查,kimi.exe 内嵌 oauth 模块):
//   POST https://auth.kimi.com/api/oauth/token (form: client_id / grant_type=refresh_token / refresh_token)
//   响应含新 access_token + 轮换的 refresh_token + expires_in(900s),必须回写否则 refresh_token 失效。
//   刷新阈值与 CLI 一致:max(300s, expires_in*0.5) = 450s。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpPostForm } = require('../../core/http');

const CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const TOKEN_URL = 'https://auth.kimi.com/api/oauth/token';
const REFRESH_THRESHOLD_MS = 450 * 1000;
const DEFAULT_CRED_MODE = 0o600;
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

function credentialMetadata(credPath) {
  try {
    const stat = fs.statSync(credPath);
    return {
      existed: true,
      mode: stat.mode & 0o777,
      uid: Number.isInteger(stat.uid) ? stat.uid : null,
      gid: Number.isInteger(stat.gid) ? stat.gid : null
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { existed: false, mode: DEFAULT_CRED_MODE, uid: null, gid: null };
    }
    throw error;
  }
}

function rawCredentialForRefresh(cred) {
  try {
    return JSON.parse(fs.readFileSync(cred.credPath, 'utf8'));
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
    const raw = {};
    if (cred.accessToken) raw.access_token = cred.accessToken;
    if (cred.refreshToken) raw.refresh_token = cred.refreshToken;
    if (cred.scope) raw.scope = cred.scope;
    if (cred.expiresAt) raw.expires_at = Math.floor(cred.expiresAt / 1000);
    return raw;
  }
}

function metadataError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function ownerMatches(stat, metadata) {
  return !metadata.existed
    || metadata.uid === null
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
    throw metadataError('CREDENTIAL_MODE_MISMATCH');
  }
  if (!ownerMatches(stat, metadata)) {
    throw metadataError('CREDENTIAL_OWNER_MISMATCH');
  }
}

function verifyTargetMetadata(credPath, metadata) {
  if (process.platform === 'win32') return;
  let stat = fs.statSync(credPath);
  if (!ownerMatches(stat, metadata)) {
    fs.chownSync(credPath, metadata.uid, metadata.gid);
    stat = fs.statSync(credPath);
  }
  if ((stat.mode & 0o777) !== metadata.mode) {
    fs.chmodSync(credPath, metadata.mode);
    stat = fs.statSync(credPath);
  }
  if ((stat.mode & 0o777) !== metadata.mode) {
    throw metadataError('CREDENTIAL_MODE_MISMATCH');
  }
  if (!ownerMatches(stat, metadata)) {
    throw metadataError('CREDENTIAL_OWNER_MISMATCH');
  }
}

function writeCredentialAtomic(credPath, raw, metadata) {
  const tmp = credPath + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', metadata.mode);
    fs.writeFileSync(fd, JSON.stringify(raw, null, 2), 'utf8');
    applyTempMetadata(fd, metadata);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tmp, credPath);
    verifyTargetMetadata(credPath, metadata);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) {}
    }
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
  }
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
    const metadata = credentialMetadata(cred.credPath);
    const raw = rawCredentialForRefresh(cred);
    raw.access_token = data.access_token;
    if (data.refresh_token) raw.refresh_token = data.refresh_token;
    if (data.scope) raw.scope = data.scope;
    if (data.token_type) raw.token_type = data.token_type;
    raw.expires_in = expiresIn;
    raw.expires_at = Math.floor(Date.now() / 1000) + expiresIn;
    writeCredentialAtomic(cred.credPath, raw, metadata);
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

module.exports = {
  readCred,
  ensureFresh,
  refreshCred,
  isExpired,
  needsRefresh,
  CLIENT_ID,
  TOKEN_URL,
  DEFAULT_CRED_PATH
};
