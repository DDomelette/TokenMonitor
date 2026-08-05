const SYSTEM_PROXY_VALUE = 'system';

function proxyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidProxySetting() {
  return proxyError('INVALID_PROXY_SETTING', '请输入有效的 HTTP 代理地址');
}

function normalizeCustomProxyUrl(rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) throw invalidProxySetting();

  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw invalidProxySetting();
  }

  if (parsed.protocol !== 'http:' || !parsed.hostname) throw invalidProxySetting();
  if (parsed.username || parsed.password) throw invalidProxySetting();
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw invalidProxySetting();
  }

  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalidProxySetting();
  }

  const hostname = parsed.hostname.toLowerCase();
  const authority = hostname.includes(':') ? `[${hostname}]` : hostname;
  return `http://${authority}${port === 80 ? '' : `:${port}`}`;
}

function normalizeProxySelection(selection) {
  const mode = selection && selection.mode;
  if (mode === 'direct') return '';
  if (mode === 'system') return SYSTEM_PROXY_VALUE;
  if (mode === 'custom') return normalizeCustomProxyUrl(selection.url);
  throw proxyError('INVALID_PROXY_MODE', '请选择有效的代理模式');
}

function normalizeStoredProxyValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  if (!text) return '';
  if (text === SYSTEM_PROXY_VALUE) return SYSTEM_PROXY_VALUE;
  return normalizeCustomProxyUrl(text);
}

function classifyStoredProxyValue(value) {
  const normalized = normalizeStoredProxyValue(value);
  if (!normalized) return { mode: 'direct', url: '' };
  if (normalized === SYSTEM_PROXY_VALUE) return { mode: 'system', url: '' };
  return { mode: 'custom', url: normalized };
}

function unsupportedSystemProxy() {
  return proxyError('UNSUPPORTED_SYSTEM_PROXY', '系统代理类型不受支持');
}

function normalizeSystemProxyAuthority(authority) {
  const match = /^(\[[^\]]+\]|[^:\s]+):(\d+)$/.exec(authority);
  if (!match) throw unsupportedSystemProxy();

  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw unsupportedSystemProxy();
  }

  try {
    return normalizeCustomProxyUrl(`http://${authority}`);
  } catch (_) {
    throw unsupportedSystemProxy();
  }
}

function parseSystemProxyResult(rawResult) {
  const directives = String(rawResult || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);

  if (directives.length === 0) return null;

  const directive = directives[0];
  const separator = directive.indexOf(' ');
  const kind = (separator === -1 ? directive : directive.slice(0, separator)).toUpperCase();
  const argument = separator === -1 ? '' : directive.slice(separator + 1).trim();

  if (kind === 'DIRECT' && !argument) return null;
  if (kind === 'PROXY' && argument) return normalizeSystemProxyAuthority(argument);
  throw unsupportedSystemProxy();
}

async function resolveElectronSystemProxy(targetUrl) {
  let defaultSession;
  try {
    const { session } = require('electron');
    defaultSession = session && session.defaultSession;
  } catch (_) {
    defaultSession = null;
  }

  if (!defaultSession || typeof defaultSession.resolveProxy !== 'function') {
    throw proxyError(
      'SYSTEM_PROXY_RESOLUTION_FAILED',
      '无法读取系统代理设置'
    );
  }

  let result;
  try {
    result = await defaultSession.resolveProxy(targetUrl);
  } catch (_) {
    throw proxyError(
      'SYSTEM_PROXY_RESOLUTION_FAILED',
      '无法读取系统代理设置'
    );
  }
  return parseSystemProxyResult(result);
}

function createProxyInputGetter({ store, resolveSystemProxy }) {
  return function getProxyInput() {
    const stored = normalizeStoredProxyValue(store.get('providers.proxyUrl'));
    if (!stored) return null;
    if (stored !== SYSTEM_PROXY_VALUE) return stored;

    return async function resolveProxyForTarget(targetUrl) {
      if (typeof resolveSystemProxy !== 'function') {
        throw proxyError(
          'SYSTEM_PROXY_RESOLUTION_FAILED',
          '无法读取系统代理设置'
        );
      }

      let result;
      try {
        result = await resolveSystemProxy(targetUrl);
      } catch (_) {
        throw proxyError(
          'SYSTEM_PROXY_RESOLUTION_FAILED',
          '无法读取系统代理设置'
        );
      }
      return parseSystemProxyResult(result);
    };
  };
}

module.exports = {
  SYSTEM_PROXY_VALUE,
  normalizeCustomProxyUrl,
  normalizeProxySelection,
  normalizeStoredProxyValue,
  classifyStoredProxyValue,
  parseSystemProxyResult,
  resolveElectronSystemProxy,
  createProxyInputGetter
};
