const net = require('node:net');

const {
  normalizeCustomProxyUrl,
  normalizeStoredProxyValue,
  classifyStoredProxyValue,
  resolveElectronSystemProxy
} = require('../../proxy-settings');
const { httpGet: defaultHttpGet } = require('../../http');

const TRANSPORT_TIMEOUTS = Object.freeze({
  connectTimeoutMs: 5000,
  connectResponseTimeoutMs: 5000,
  tlsHandshakeTimeoutMs: 5000,
  requestTimeoutMs: 8000
});
const REQUEST_TIMEOUT_MS = 8000;
const PROXY_GUIDE = 'network-proxy';
const TLS_GUIDE = 'network-tls';
const TLS_CERT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID'
]);
const TCP_TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT'
]);
const HTTP_TIMEOUT_CODES = new Set([
  'ESOCKETTIMEDOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
]);

const ENDPOINTS = Object.freeze([
  {
    id: 'network.deepseek-api',
    title: 'DeepSeek API endpoint',
    guideId: 'deepseek-api-key',
    url: 'https://api.deepseek.com/user/balance'
  },
  {
    id: 'network.deepseek-platform',
    title: 'DeepSeek platform endpoint',
    guideId: 'deepseek-session',
    url: 'https://platform.deepseek.com/usage'
  },
  {
    id: 'network.codex',
    title: 'Codex endpoint',
    guideId: 'codex-auth',
    url: 'https://chatgpt.com/backend-api/wham/usage'
  },
  {
    id: 'network.kimi',
    title: 'Kimi endpoint',
    guideId: 'kimi-auth',
    url: 'https://api.kimi.com/coding/v1/usages'
  }
]);

function classifyNetworkError(error) {
  const code = typeof (error && error.code) === 'string' ? error.code : '';
  const message = typeof (error && error.message) === 'string' ? error.message : '';

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { reachedHttp: false, stage: 'dns', errorCode: 'NETWORK_DNS_FAILED' };
  }
  if (code === 'PROXY_CONNECT_RESPONSE_TIMEOUT' || code === 'PROXY_CONNECT_HEADER_TOO_LARGE') {
    return { reachedHttp: false, stage: 'proxy-connect', errorCode: 'NETWORK_TIMEOUT' };
  }
  if (code === 'PROXY_TCP_CONNECT_TIMEOUT') {
    return { reachedHttp: false, stage: 'tcp', errorCode: 'NETWORK_TIMEOUT' };
  }
  if (code === 'PROXY_TLS_HANDSHAKE_TIMEOUT') {
    return { reachedHttp: false, stage: 'tls', errorCode: 'NETWORK_TIMEOUT' };
  }
  if (TCP_TIMEOUT_CODES.has(code)) {
    return { reachedHttp: false, stage: 'tcp', errorCode: 'NETWORK_TIMEOUT' };
  }
  if (HTTP_TIMEOUT_CODES.has(code)) {
    return { reachedHttp: false, stage: 'http', errorCode: 'NETWORK_TIMEOUT' };
  }
  if (code === 'HTTPS_REQUEST_TIMEOUT' || code === 'DIAGNOSTIC_TIMEOUT' || /_TIMEOUT$/.test(code)) {
    return { reachedHttp: false, stage: 'http', errorCode: 'NETWORK_TIMEOUT' };
  }
  if (code === 'PROXY_CONNECT_FAILED' || code === 'PROXY_CONNECT_REJECTED') {
    return { reachedHttp: false, stage: 'proxy-connect', errorCode: 'NETWORK_PROXY_CONNECT_FAILED' };
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /^ERR_TLS_/.test(code) || /^CERT_/.test(code) || TLS_CERT_CODES.has(code)) {
    return { reachedHttp: false, stage: 'tls', errorCode: 'NETWORK_TLS_FAILED' };
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { reachedHttp: false, stage: 'tcp', errorCode: 'NETWORK_TCP_FAILED' };
  }
  if (code === 'SYSTEM_PROXY_RESOLUTION_FAILED' || code === 'UNSUPPORTED_SYSTEM_PROXY') {
    return { reachedHttp: false, stage: 'proxy-config', errorCode: 'NETWORK_PROXY_CONFIG_FAILED' };
  }
  if (/^proxy CONNECT failed:/i.test(message)) {
    return { reachedHttp: false, stage: 'proxy-connect', errorCode: 'NETWORK_PROXY_CONNECT_FAILED' };
  }
  if (/Unauthorized:.*HTTP\s+(401|403)/i.test(message)
    || /^HTTP\s+\d{3}\b/i.test(message)
    || message === 'Failed to parse response') {
    return { reachedHttp: true, stage: 'http', errorCode: 'NETWORK_HTTP_REACHED' };
  }
  return { reachedHttp: false, stage: 'tcp', errorCode: 'NETWORK_TCP_FAILED' };
}

function safeHost(url) {
  try {
    const host = new URL(url).hostname;
    return net.isIP(host.replace(/^\[|\]$/g, '')) ? '' : host;
  } catch (_) {
    return '';
  }
}

function httpStatus(error) {
  const message = typeof (error && error.message) === 'string' ? error.message : '';
  const match = /^HTTP\s+(\d{3})\b/i.exec(message);
  return match ? Number(match[1]) : null;
}

async function probeEndpoint(options = {}) {
  const host = safeHost(options.url);
  const request = typeof options.httpGet === 'function' ? options.httpGet : defaultHttpGet;
  const timeoutOptions = options.timeoutOptions || TRANSPORT_TIMEOUTS;
  try {
    await request(options.url, {}, options.proxyInput || null, timeoutOptions);
    return {
      status: 'pass',
      summary: 'Endpoint is reachable',
      metadata: { stage: 'http', host }
    };
  } catch (error) {
    const classified = classifyNetworkError(error);
    const status = httpStatus(error);
    if (classified.reachedHttp && !(status >= 500 && status <= 599)) {
      return {
        status: 'pass',
        summary: 'Endpoint is reachable',
        metadata: { stage: 'http', host }
      };
    }
    return {
      status: 'fail',
      summary: 'Endpoint reachability check failed',
      errorCode: status >= 500 && status <= 599 ? 'NETWORK_HTTP_FAILED' : classified.errorCode,
      metadata: { stage: classified.stage, host }
    };
  }
}

function normalizedProxyParts(proxyUrl, normalize = normalizeCustomProxyUrl) {
  try {
    const normalized = normalize(proxyUrl);
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password
      || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
      throw new Error('invalid proxy');
    }
    const port = parsed.port ? Number(parsed.port) : 80;
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('invalid proxy');
    }
    return { host: parsed.hostname, port };
  } catch (_) {
    return null;
  }
}

function proxyFailure(summary, errorCode, stage) {
  return { status: 'fail', summary, errorCode, metadata: { stage } };
}

function probeProxyTcp(options = {}) {
  const parts = normalizedProxyParts(options.proxyUrl, options.normalizeCustomProxyUrl);
  if (!parts) {
    return Promise.resolve(proxyFailure(
      'Custom proxy configuration is invalid',
      'NETWORK_PROXY_CONFIG_INVALID',
      'proxy-config'
    ));
  }

  const connect = typeof options.netConnect === 'function' ? options.netConnect : net.connect;
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : TRANSPORT_TIMEOUTS.connectTimeoutMs;
  const signal = options.signal;

  return new Promise((resolve) => {
    let socket;
    let timer;
    let settled = false;
    const remove = (event, listener) => {
      if (!socket) return;
      if (typeof socket.off === 'function') socket.off(event, listener);
      else if (typeof socket.removeListener === 'function') socket.removeListener(event, listener);
    };
    const destroy = () => {
      if (socket && !socket.destroyed && typeof socket.destroy === 'function') {
        try {
          socket.destroy();
        } catch (_) {
          // Resource cleanup cannot expose transport details.
        }
      }
    };
    const cleanup = () => {
      if (timer !== undefined) {
        try { clearTimer(timer); } catch (_) { /* no-op */ }
        timer = undefined;
      }
      remove('connect', onConnect);
      remove('error', onError);
      if (signal && typeof signal.removeEventListener === 'function') {
        try { signal.removeEventListener('abort', onAbort); } catch (_) { /* no-op */ }
      }
    };
    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      destroy();
      resolve(result);
    };
    const onConnect = () => settle({
      status: 'pass',
      summary: 'Custom proxy TCP connection succeeded',
      metadata: { stage: 'tcp' }
    });
    const onError = (error) => {
      const classified = classifyNetworkError(error);
      settle(proxyFailure(
        'Custom proxy TCP connection failed',
        classified.errorCode,
        classified.stage === 'dns' ? 'dns' : 'tcp',
        parts
      ));
    };
    const onAbort = () => settle(proxyFailure(
      'Custom proxy TCP connection aborted',
      'DIAGNOSTIC_ABORTED',
      'tcp'
    ));
    try {
      if (signal && signal.aborted) {
        onAbort();
        return;
      }
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (signal && signal.aborted) {
        onAbort();
        return;
      }
      socket = connect(parts.port, parts.host);
      if (!socket || typeof socket.once !== 'function') throw new Error('socket unavailable');
      socket.once('connect', onConnect);
      socket.once('error', onError);
      timer = setTimer(() => settle(proxyFailure(
        'Custom proxy TCP connection failed',
        'NETWORK_TIMEOUT',
        'tcp',
        parts
      )), timeoutMs);
    } catch (error) {
      const classified = classifyNetworkError(error);
      settle(proxyFailure(
        'Custom proxy TCP connection failed',
        classified.errorCode,
        classified.stage === 'dns' ? 'dns' : 'tcp',
        parts
      ));
    }
  });
}

function definition(id, title, guideId, phase, run, timeoutMs) {
  return { id, group: 'Network', title, guideId, phase, timeoutMs, run };
}

function skippedProxyCheck(summary) {
  return { status: 'skipped', summary };
}

function consumeThenable(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  let then;
  try {
    then = value.then;
  } catch (_) {
    return true;
  }
  if (typeof then !== 'function') return false;
  try {
    const chained = then.call(value, () => {}, () => {});
    if (chained && typeof chained.catch === 'function') {
      try { chained.catch(() => {}); } catch (_) { /* fail closed below */ }
    }
  } catch (_) {
    // The stored value remains invalid; never expose an async-value error.
  }
  return true;
}

function captureProxySnapshot(dependencies = {}) {
  try {
    const store = dependencies.store;
    const readStoredProxy = typeof dependencies.getStoredProxyValue === 'function'
      ? dependencies.getStoredProxyValue
      : () => store && typeof store.get === 'function' ? store.get('providers.proxyUrl') : '';
    const normalizeStored = dependencies.normalizeStoredProxyValue || normalizeStoredProxyValue;
    const classifyStored = dependencies.classifyStoredProxyValue || classifyStoredProxyValue;
    const resolveSystem = dependencies.resolveElectronSystemProxy || resolveElectronSystemProxy;
    const storedProxy = readStoredProxy();
    if (consumeThenable(storedProxy)) throw new Error('asynchronous proxy value');
    const proxy = classifyStored(normalizeStored(storedProxy));
    if (proxy.mode === 'custom' && typeof proxy.url === 'string') {
      return Object.freeze({ mode: 'custom', input: proxy.url });
    }
    if (proxy.mode === 'system') {
      return Object.freeze({
        mode: 'system',
        input: (targetUrl) => Promise.resolve().then(() => resolveSystem(targetUrl))
      });
    }
    if (proxy.mode === 'direct') return Object.freeze({ mode: 'direct', input: null });
  } catch (_) {
    // Invalid or asynchronous configuration is represented without retaining its value.
  }
  return Object.freeze({ mode: 'invalid', input: null });
}

function proxyFromContext(context) {
  try {
    const runScope = context && context.runScope;
    const proxy = runScope && runScope.proxy;
    if (!proxy || typeof proxy !== 'object') throw new Error('missing proxy scope');
    if (proxy.mode === 'direct' && proxy.input === null) return proxy;
    if (proxy.mode === 'custom' && typeof proxy.input === 'string') return proxy;
    if (proxy.mode === 'system' && typeof proxy.input === 'function') return proxy;
    if (proxy.mode === 'invalid' && proxy.input === null) return proxy;
  } catch (_) {
    // Missing or hostile contexts fail closed.
  }
  return { mode: 'invalid', input: null };
}

function transportOptions(context) {
  return Object.assign({}, TRANSPORT_TIMEOUTS, {
    signal: context && context.signal,
    deadlineMs: context && context.deadlineMs
  });
}

function createNetworkChecks(dependencies = {}) {
  const transport = {
    netConnect: dependencies.netConnect,
    setTimeout: dependencies.setTimeout,
    clearTimeout: dependencies.clearTimeout,
    timeoutMs: TRANSPORT_TIMEOUTS.connectTimeoutMs,
    normalizeCustomProxyUrl: dependencies.normalizeCustomProxyUrl || normalizeCustomProxyUrl
  };

  const checks = [
    definition('network.proxy-config', 'Proxy configuration', PROXY_GUIDE, 'local', (context) => {
      const proxy = proxyFromContext(context);
      return proxy.mode === 'invalid'
        ? { status: 'fail', summary: 'Stored proxy configuration is invalid', errorCode: 'NETWORK_PROXY_CONFIG_INVALID' }
        : { status: 'pass', summary: 'Proxy configuration is valid', metadata: { mode: proxy.mode } };
    }, 3000),
    definition('network.system-proxy', 'System proxy TCP connection', PROXY_GUIDE, 'remote', async (context) => {
      const proxy = proxyFromContext(context);
      if (proxy.mode !== 'system') return skippedProxyCheck('System proxy is not selected');
      try {
        const resolved = await proxy.input(ENDPOINTS[0].url);
        if (!resolved) return { status: 'pass', summary: 'System proxy resolves to direct connection', metadata: { stage: 'proxy-config' } };
        return probeProxyTcp(Object.assign({}, transport, {
          proxyUrl: resolved,
          signal: context && context.signal
        }));
      } catch (error) {
        const classified = classifyNetworkError(error);
        return {
          status: 'fail',
          summary: 'System proxy resolution failed',
          errorCode: classified.errorCode,
          metadata: { stage: classified.stage }
        };
      }
    }, REQUEST_TIMEOUT_MS),
    definition('network.custom-proxy', 'Custom proxy TCP connection', PROXY_GUIDE, 'remote', (context) => {
      const proxy = proxyFromContext(context);
      if (proxy.mode !== 'custom') return skippedProxyCheck('Custom proxy is not selected');
      return probeProxyTcp(Object.assign({}, transport, {
        proxyUrl: proxy.input,
        signal: context && context.signal
      }));
    }, REQUEST_TIMEOUT_MS)
  ];

  for (const endpoint of ENDPOINTS) {
    checks.push(definition(endpoint.id, endpoint.title, endpoint.guideId, 'remote', (context) => {
      const proxy = proxyFromContext(context);
      return probeEndpoint({
      url: endpoint.url,
      httpGet: dependencies.httpGet || defaultHttpGet,
      proxyInput: proxy.mode === 'invalid' ? null : proxy.input,
      timeoutOptions: transportOptions(context)
      });
    }, REQUEST_TIMEOUT_MS));
  }
  return checks;
}

module.exports = {
  TRANSPORT_TIMEOUTS,
  classifyNetworkError,
  probeEndpoint,
  probeProxyTcp,
  captureProxySnapshot,
  createNetworkChecks
};
