// 主进程 HTTP 客户端:HTTPS GET,支持经 HTTP CONNECT 代理隧道(chatgpt.com 等需代理的域)。
const https = require('https');
const net = require('net');
const tls = require('tls');

const DEFAULT_TIMEOUTS = Object.freeze({
  connectTimeoutMs: 10000,
  connectResponseTimeoutMs: 10000,
  tlsHandshakeTimeoutMs: 10000,
  requestTimeoutMs: 20000
});

function proxyConfigError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stageTimeoutError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function timeoutValue(options, key, fallback) {
  if (!options || options[key] === undefined) return fallback;
  const value = Number(options[key]);
  if (!Number.isFinite(value) || value <= 0) {
    throw proxyConfigError('INVALID_HTTP_TIMEOUT', 'Invalid HTTP timeout: ' + key);
  }
  return Math.floor(value);
}

function normalizeTimeouts(options) {
  return {
    connectTimeoutMs: timeoutValue(
      options,
      'connectTimeoutMs',
      DEFAULT_TIMEOUTS.connectTimeoutMs
    ),
    connectResponseTimeoutMs: timeoutValue(
      options,
      'connectResponseTimeoutMs',
      DEFAULT_TIMEOUTS.connectResponseTimeoutMs
    ),
    tlsHandshakeTimeoutMs: timeoutValue(
      options,
      'tlsHandshakeTimeoutMs',
      DEFAULT_TIMEOUTS.tlsHandshakeTimeoutMs
    ),
    requestTimeoutMs: timeoutValue(
      options,
      'requestTimeoutMs',
      DEFAULT_TIMEOUTS.requestTimeoutMs
    )
  };
}

function explicitNumericPort(rawUrl) {
  const schemeEnd = rawUrl.indexOf('://');
  if (schemeEnd < 0) return null;
  const authority = rawUrl.slice(schemeEnd + 3).split(/[/?#]/, 1)[0];
  const match = /:(\d+)$/.exec(authority);
  return match ? Number(match[1]) : null;
}

function parseProxyUrl(url) {
  if (url === null || url === undefined) return null;
  if (typeof url !== 'string') {
    throw proxyConfigError('INVALID_PROXY_URL', 'Invalid proxy URL: expected http://host[:port]');
  }

  const raw = url.trim();
  if (!raw) return null;
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
  if (!schemeMatch) {
    throw proxyConfigError('INVALID_PROXY_URL', 'Invalid proxy URL: expected http://host[:port]');
  }

  const protocol = schemeMatch[1].toLowerCase() + ':';
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw proxyConfigError(
      'UNSUPPORTED_PROXY_PROTOCOL',
      'Unsupported proxy protocol: ' + protocol
    );
  }

  const explicitPort = explicitNumericPort(raw);
  if (explicitPort !== null && (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65535)) {
    throw proxyConfigError('INVALID_PROXY_PORT', 'Invalid proxy port: ' + explicitPort);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw proxyConfigError('INVALID_PROXY_URL', 'Invalid proxy URL: expected http://host[:port]');
  }
  if (!parsed.hostname) {
    throw proxyConfigError('INVALID_PROXY_URL', 'Invalid proxy URL: hostname is required');
  }

  const port = parsed.port
    ? Number(parsed.port)
    : (protocol === 'https:' ? 443 : 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw proxyConfigError('INVALID_PROXY_PORT', 'Invalid proxy port: ' + String(parsed.port));
  }

  return { protocol, host: parsed.hostname, port };
}

function assertSupportedProxy(proxy) {
  if (!proxy || proxy.protocol === 'http:') return;
  if (proxy.protocol === 'https:') {
    throw proxyConfigError(
      'HTTPS_PROXY_UNSUPPORTED',
      'HTTPS proxy URLs are not supported; use an http:// proxy URL'
    );
  }
  throw proxyConfigError(
    'UNSUPPORTED_PROXY_PROTOCOL',
    'Unsupported proxy protocol: ' + String(proxy.protocol || '')
  );
}

// GET JSON。2xx 解析 JSON 并 resolve;401/403 reject 含 "Unauthorized: ... (HTTP xxx)"(供 scheduler 判定 authStatus);
// 其余非 2xx reject 含状态码与响应体片段。headers / proxyUrl / timeoutOptions 均可选。
function httpGet(url, headers, proxyUrl, timeoutOptions) {
  return requestCore('GET', url, headers, null, proxyUrl, timeoutOptions);
}

// POST JSON,返回解析后的 JSON(供 codex refresh_token 等场景)。
function httpPostJson(url, jsonBody, headers, proxyUrl, timeoutOptions) {
  return requestCore(
    'POST',
    url,
    headers,
    JSON.stringify(jsonBody),
    proxyUrl,
    timeoutOptions
  );
}

// POST application/x-www-form-urlencoded(kimi OAuth refresh 等场景)。
function httpPostForm(url, formObj, headers, proxyUrl, timeoutOptions) {
  const body = Object.keys(formObj)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(formObj[k]))
    .join('&');
  return requestCore(
    'POST',
    url,
    Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, headers),
    body,
    proxyUrl,
    timeoutOptions
  );
}

function requestCore(method, url, headers, body, proxyUrl, timeoutOptions) {
  return new Promise((resolve, reject) => {
    let target;
    let timeouts;
    let proxy;
    try {
      target = new URL(url);
      timeouts = normalizeTimeouts(timeoutOptions);
      proxy = parseProxyUrl(proxyUrl);
      assertSupportedProxy(proxy);
    } catch (error) {
      reject(error);
      return;
    }

    const reqHeaders = Object.assign({
      'Accept': 'application/json',
      'User-Agent': 'deepseek-monitor/1.0'
    }, headers || {});
    if (body && !reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';

    let settled = false;
    let proxySocket = null;
    let tlsSocket = null;
    let request = null;
    let connectTimer = null;
    let connectResponseTimer = null;
    let tlsHandshakeTimer = null;

    function clearTimer(timer) {
      if (timer) clearTimeout(timer);
    }

    function clearStageTimers() {
      clearTimer(connectTimer);
      clearTimer(connectResponseTimer);
      clearTimer(tlsHandshakeTimer);
      connectTimer = null;
      connectResponseTimer = null;
      tlsHandshakeTimer = null;
    }

    function destroyActiveTransport() {
      if (request && !request.destroyed) {
        request.destroy();
        return;
      }
      if (tlsSocket && !tlsSocket.destroyed) {
        tlsSocket.destroy();
        return;
      }
      if (proxySocket && !proxySocket.destroyed) proxySocket.destroy();
    }

    function rejectOnce(error, destroyTransport) {
      if (settled) return;
      settled = true;
      clearStageTimers();
      if (destroyTransport) destroyActiveTransport();
      reject(error);
    }

    function resolveOnce(value) {
      if (settled) return;
      settled = true;
      clearStageTimers();
      resolve(value);
    }

    const doRequest = (socket) => {
      if (settled) return;
      try {
        request = https.request(
          Object.assign(
            {
              hostname: target.hostname,
              port: target.port || 443,
              path: target.pathname + target.search,
              method: method,
              headers: reqHeaders,
              rejectUnauthorized: true
            },
            socket ? { createConnection: () => socket } : {}
          ),
          (res) => {
            let resBody = '';
            res.on('data', (c) => { resBody += c; });
            res.once('error', (error) => rejectOnce(error, true));
            res.on('end', () => {
              if (res.statusCode === 401 || res.statusCode === 403) {
                rejectOnce(
                  new Error('Unauthorized: session expired (HTTP ' + res.statusCode + ')'),
                  false
                );
                return;
              }
              if (res.statusCode < 200 || res.statusCode >= 300) {
                rejectOnce(
                  new Error('HTTP ' + res.statusCode + ': ' + resBody.slice(0, 300)),
                  false
                );
                return;
              }
              try {
                resolveOnce(JSON.parse(resBody));
              } catch (error) {
                rejectOnce(new Error('Failed to parse response'), false);
              }
            });
          }
        );
      } catch (error) {
        rejectOnce(error, true);
        return;
      }

      request.once('error', (error) => rejectOnce(error, true));
      request.setTimeout(timeouts.requestTimeoutMs, () => {
        rejectOnce(
          stageTimeoutError('HTTPS_REQUEST_TIMEOUT', 'HTTPS request timeout'),
          true
        );
      });
      try {
        if (body) request.write(body);
        request.end();
      } catch (error) {
        rejectOnce(error, true);
      }
    };

    if (!proxy) {
      doRequest(null);
      return;
    }

    // CONNECT 隧道的每个等待阶段独立计时。响应分片缓冲由 #26 单独处理。
    try {
      proxySocket = net.connect(proxy.port, proxy.host);
    } catch (error) {
      rejectOnce(error, false);
      return;
    }

    connectTimer = setTimeout(() => {
      rejectOnce(
        stageTimeoutError(
          'PROXY_TCP_CONNECT_TIMEOUT',
          'Proxy TCP connect timeout'
        ),
        true
      );
    }, timeouts.connectTimeoutMs);

    proxySocket.once('connect', () => {
      if (settled) return;
      clearTimer(connectTimer);
      connectTimer = null;
      try {
        proxySocket.write(
          'CONNECT ' + target.hostname + ':443 HTTP/1.1\r\n'
          + 'Host: ' + target.hostname + ':443\r\n\r\n'
        );
      } catch (error) {
        rejectOnce(error, true);
        return;
      }
      connectResponseTimer = setTimeout(() => {
        rejectOnce(
          stageTimeoutError(
            'PROXY_CONNECT_RESPONSE_TIMEOUT',
            'Proxy CONNECT response timeout'
          ),
          true
        );
      }, timeouts.connectResponseTimeoutMs);
    });

    proxySocket.once('data', (chunk) => {
      if (settled) return;
      clearTimer(connectResponseTimer);
      connectResponseTimer = null;
      const head = chunk.toString('latin1');
      if (!/^HTTP\/1\.[01] 200/i.test(head)) {
        rejectOnce(
          new Error('proxy CONNECT failed: ' + head.split('\r\n')[0]),
          true
        );
        return;
      }

      try {
        tlsSocket = tls.connect({
          socket: proxySocket,
          servername: target.hostname,
          rejectUnauthorized: true
        });
      } catch (error) {
        rejectOnce(error, true);
        return;
      }
      tlsHandshakeTimer = setTimeout(() => {
        rejectOnce(
          stageTimeoutError(
            'PROXY_TLS_HANDSHAKE_TIMEOUT',
            'Proxy TLS handshake timeout'
          ),
          true
        );
      }, timeouts.tlsHandshakeTimeoutMs);

      tlsSocket.once('secureConnect', () => {
        if (settled) return;
        clearTimer(tlsHandshakeTimer);
        tlsHandshakeTimer = null;
        doRequest(tlsSocket);
      });
      tlsSocket.once('error', (error) => rejectOnce(error, true));
    });
    proxySocket.once('error', (error) => rejectOnce(error, true));
  });
}

module.exports = {
  httpGet,
  httpPostJson,
  httpPostForm,
  parseProxyUrl,
  assertSupportedProxy
};
