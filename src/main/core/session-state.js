const SESSION_STATUSES = new Set(['missing', 'valid', 'expired']);

function normalizeToken(token) {
  if (typeof token !== 'string') return null;
  const value = token.trim();
  return value ? value : null;
}

function getSessionSnapshot(runtime) {
  const token = normalizeToken(runtime && runtime.sessionToken);
  const declared = runtime && SESSION_STATUSES.has(runtime.sessionStatus)
    ? runtime.sessionStatus
    : (token ? 'valid' : 'missing');
  const loggedIn = declared === 'valid' && !!token;
  const status = loggedIn ? 'valid' : (declared === 'expired' ? 'expired' : 'missing');

  return {
    status,
    loggedIn,
    error: status === 'valid' ? null : ((runtime && runtime.sessionError) || null)
  };
}

function restoreSession(runtime, token) {
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('restoreSession requires a runtime object');
  }

  const nextToken = normalizeToken(token);
  runtime.sessionToken = nextToken;
  runtime.sessionStatus = nextToken ? 'valid' : 'missing';
  runtime.sessionError = null;
  return getSessionSnapshot(runtime);
}

function clearSession(runtime, message) {
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('clearSession requires a runtime object');
  }

  runtime.sessionToken = null;
  runtime.sessionStatus = 'missing';
  runtime.sessionError = message || null;
  return getSessionSnapshot(runtime);
}

function expireSession(runtime, message) {
  if (!runtime || typeof runtime !== 'object') {
    throw new TypeError('expireSession requires a runtime object');
  }

  runtime.sessionToken = null;
  runtime.sessionStatus = 'expired';
  runtime.sessionError = message || '会话已过期，请重新登录';
  return getSessionSnapshot(runtime);
}

function getTraySessionLabel(snapshot) {
  if (snapshot && snapshot.loggedIn) return '重新登录平台';
  if (snapshot && snapshot.status === 'expired') return '会话已过期，重新登录';
  return '登录平台获取用量';
}

module.exports = {
  clearSession,
  expireSession,
  getSessionSnapshot,
  getTraySessionLabel,
  restoreSession
};
