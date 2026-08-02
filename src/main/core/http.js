// 主进程 HTTP 客户端:HTTPS GET,支持经 HTTP CONNECT 代理隧道(chatgpt.com 等需代理的域)。
const https = require('https');
const net = require('net');
const tls = require('tls');

function parseProxyUrl(url) {
  if (!url) return null;
  const m = /^https?:\/\/([^:/]+)(?::(\d+))?/.exec(url);
  return m ? { host: m[1], port: m[2] ? Number(m[2]) : 80 } : null;
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

function requestCore(method, url, headers, body, proxyUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const reqHeaders = Object.assign({
      'Accept': 'application/json',
      'User-Agent': 'deepseek-monitor/1.0'
    }, headers || {});
    if (body) reqHeaders['Content-Type'] = 'application/json';

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

    const proxy = parseProxyUrl(proxyUrl);
    if (!proxy) {
      doRequest(null);
      return;
    }

    // CONNECT 隧道:先与代理建连,再包 TLS。
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

module.exports = { httpGet, httpPostJson, parseProxyUrl };
