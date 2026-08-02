// 一次性调研脚本(非产品代码):验证 codex / kimi 的 OAuth refresh_token 刷新端点。
// 用法: node scripts/spike-refresh.js [--proxy=http://127.0.0.1:7890]
// 安全: 任何 token 只打印前 8 位, 绝不打印完整凭据。
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const net = require('net');
const tls = require('tls');

const PROXY_ARG = process.argv.find(function (a) { return a.startsWith('--proxy='); });
const PROXY = PROXY_ARG ? PROXY_ARG.slice('--proxy='.length) : null;

function redact(token) {
  return token ? token.slice(0, 8) + '...' : '(none)';
}

function parseProxy(url) {
  const m = /^https?:\/\/([^:/]+)(?::(\d+))?/.exec(url || '');
  return m ? { host: m[1], port: m[2] ? Number(m[2]) : 80 } : null;
}

// 发起 HTTPS 请求, 支持经 HTTP CONNECT 代理隧道(chatgpt.com 走 127.0.0.1:7890)。
function request(url, opts) {
  opts = opts || {};
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const method = (opts.method || 'GET').toUpperCase();
  const headers = Object.assign({ 'User-Agent': 'deepseek-monitor-spike/1.0' }, opts.headers || {});

  return new Promise(function (resolve, reject) {
    const doRequest = function (socket) {
      const req = https.request(
        Object.assign(
          {
            hostname: target.hostname,
            port: target.port || 443,
            path: target.pathname + target.search,
            method: method,
            headers: headers,
            rejectUnauthorized: true
          },
          socket ? { createConnection: function () { return socket; } } : {}
        ),
        function (res) {
          let body = '';
          res.on('data', function (c) { body += c; });
          res.on('end', function () {
            resolve({ status: res.statusCode, headers: res.headers, body: body });
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(20000, function () { req.destroy(new Error('timeout')); });
      if (opts.body) req.write(opts.body);
      req.end();
    };

    if (!PROXY) {
      doRequest(null);
      return;
    }

    // CONNECT 隧道: 先与代理建连, 再包 TLS。
    const p = parseProxy(PROXY);
    if (!p) { reject(new Error('bad proxy url: ' + PROXY)); return; }
    const conn = net.connect(p.port, p.host, function () {
      conn.write('CONNECT ' + target.hostname + ':443 HTTP/1.1\r\nHost: ' + target.hostname + ':443\r\n\r\n');
    });
    conn.once('data', function (chunk) {
      const head = chunk.toString('latin1');
      if (!/^HTTP\/1\.[01] 200/i.test(head)) {
        conn.destroy();
        reject(new Error('proxy CONNECT failed: ' + head.split('\r\n')[0]));
        return;
      }
      const tlsSocket = tls.connect({ socket: conn, servername: target.hostname, rejectUnauthorized: true }, function () {
        doRequest(tlsSocket);
      });
      tlsSocket.on('error', reject);
    });
    conn.on('error', reject);
  });
}

function postForm(url, form) {
  const body = Object.keys(form)
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(form[k]); })
    .join('&');
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body: body
  });
}

function postJson(url, json) {
  const body = JSON.stringify(json);
  return request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body: body
  });
}

// ---- 1) Codex ----
async function spikeCodex() {
  console.log('==== Codex refresh ====');
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  if (!fs.existsSync(authPath)) { console.log('auth.json 不存在, 跳过'); return; }
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const refreshToken = auth.tokens && auth.tokens.refresh_token;
  console.log('last_refresh:', auth.last_refresh, '| refresh_token:', redact(refreshToken));

  if (!refreshToken) { console.log('无 refresh_token, 降级: 轮询前重读 auth.json'); return; }

  // 端点/格式来自 openai/codex 源码 codex-rs/login/src/auth/manager.rs:
  // POST https://auth.openai.com/oauth/token  Content-Type: application/json
  // { "client_id": "app_EMoamEEZ73f0CkXaXp7hrann", "grant_type": "refresh_token", "refresh_token": ... }
  const url = 'https://auth.openai.com/oauth/token';
  try {
    const res = await postJson(url, {
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });
    console.log('POST', url, '->', res.status);
    if (res.status === 200) {
      try {
        const data = JSON.parse(res.body);
        console.log('新 access_token:', redact(data.access_token), '| expires_in:', data.expires_in);
      } catch (e) {
        console.log('响应非 JSON:', res.body.slice(0, 200));
      }
    } else {
      console.log('响应:', res.body.slice(0, 300));
    }
  } catch (e) {
    console.log('codex refresh 失败:', e.message);
  }
}

// ---- 2) Kimi ----
async function spikeKimi() {
  console.log('==== Kimi refresh ====');
  const credPath = path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json');
  if (!fs.existsSync(credPath)) { console.log('credentials 不存在, 跳过'); return; }
  const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  console.log('access_token:', redact(cred.access_token), '| refresh_token:', redact(cred.refresh_token), '| expires_at:', cred.expires_at, '| scope:', cred.scope);

  // kimi CLI 二进制中 OAuth server 为 https://auth.kimi.com(MCP OAuth 发现制)。
  const wellKnownCandidates = [
    'https://auth.kimi.com/.well-known/oauth-authorization-server',
    'https://auth.kimi.com/.well-known/openid-configuration',
    'https://api.kimi.com/coding/v1/.well-known/oauth-authorization-server'
  ];
  let tokenUrl = null;
  for (const wk of wellKnownCandidates) {
    try {
      const meta = await request(wk);
      console.log('GET', wk, '->', meta.status);
      if (meta.status === 200) {
        const json = JSON.parse(meta.body);
        tokenUrl = json.token_endpoint || json.authorization_endpoint;
        console.log('metadata token_endpoint:', tokenUrl, '| issuer:', json.issuer);
        break;
      }
    } catch (e) {
      console.log('well-known 发现失败:', wk, e.message);
    }
  }

  if (!tokenUrl) {
    tokenUrl = 'https://auth.kimi.com/oauth/token';
    console.log('回退候选 token_endpoint:', tokenUrl);
  }

  try {
    // 从 kimi.exe 二进制提取的 KIMI_CODE_FLOW_CONFIG:
    //   oauthHost: https://auth.kimi.com, clientId: 17e5f671-d194-4dfb-9706-5516cb48c098
    const res = await postForm(tokenUrl, {
      grant_type: 'refresh_token',
      refresh_token: cred.refresh_token,
      client_id: '17e5f671-d194-4dfb-9706-5516cb48c098'
    });
    console.log('POST', tokenUrl, '->', res.status);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      console.log('新 access_token:', redact(data.access_token), '| expires_in:', data.expires_in);
    } else {
      console.log('响应:', res.body.slice(0, 300));
    }
  } catch (e) {
    console.log('kimi refresh 失败:', e.message);
  }
}

(async function main() {
  console.log('proxy:', PROXY || '(直连)');
  await spikeCodex();
  await spikeKimi();
})();
