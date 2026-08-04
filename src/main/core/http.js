// 主进程 HTTP 客户端:HTTPS GET,支持经 HTTP CONNECT 代理隧道(chatgpt.com 等需代理的域)。
const https = require('https');
const net = require('net');
const tls = require('tls');

function proxyConfigError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
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
// 其余非 2xx reject 含状态码与响应体片段。headers 可选,proxyUrl 可选。
function httpGet(url, headers, proxyUrl) {
  return requestCore('GET', url, headers, null, proxyUrl);
}

// POST JSON,返回解析后的 JSON(供 codex refresh_token 等场景)。
function httpPostJson(url, jsonBody, headers, proxyUrl) {
  return requestCore('POST', url, headers, JSON.stringify(jsonBody), proxyUrl);
}

// POST application/x-www-form-urlencoded(kimi OAuth refresh 等场景)。
function httpPostForm(url, formObj, headers, proxyUrl) {
  const body = Object.keys(formObj)
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(formObj[k]))
    .join('&');
  return requestCore('POST', url, Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, headers), body, proxyUrl);
}

function requestCore(method, url, headers, body, proxyUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const reqHeaders = Object.assign({
      'Accept': 'application/json',
      'User-Agent': 'deepseek-monitor/1.0'
    }, headers || {});
    if (body && !reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';

    const doRequest = (socket) => {
      const req = https.request(
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
          res.on('end', () => {
            if (res.statusCode === 401 || res.statusCode === 403) {
              reject(new Error('Unauthorized: session expired (HTTP ' + res.statusCode + ')'));
              return;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error('HTTP ' + res.statusCode + ': ' + resBody.slice(0, 300)));
              return;
            }
            try {
              resolve(JSON.parse(resBody));
            } catch (e) {
              reject(new Error('Failed to parse response'));
            }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(new Error('Request timeout')); });
      if (body) req.write(body);
      req.end();
    };

    let proxy;
    try {
      proxy = parseProxyUrl(proxyUrl);
      assertSupportedProxy(proxy);
    } catch (error) {
      reject(error);
      return;
    }
    if (!proxy) {
      doRequest(null);
      return;
    }

    // CONNECT 隧道:先与 HTTP 代理建立明文连接,再把目标连接包 TLS。
    const conn = net.connect(proxy.port, proxy.host, () => {
      conn.write('CONNECT ' + target.hostname + ':443 HTTP/1.1\r\nHost: ' + target.hostname + ':443\r\n\r\n');
    });
    conn.once('data', (chunk) => {
      const head = chunk.toString('latin1');
      if (!/^HTTP\/1\.[01] 200/i.test(head)) {
        conn.destroy();
        reject(new Error('proxy CONNECT failed: ' + head.split('\r\n')[0]));
        return;
      }
      const tlsSocket = tls.connect({ socket: conn, servername: target.hostname, rejectUnauthorized: true }, () => {
        doRequest(tlsSocket);
      });
      tlsSocket.on('error', reject);
    });
    conn.on('error', reject);
  });
}

module.exports = {
  httpGet,
  httpPostJson,
  httpPostForm,
  parseProxyUrl,
  assertSupportedProxy
};
