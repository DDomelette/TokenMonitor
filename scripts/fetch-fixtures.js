// 一次性脚本:抓取今日真实 wham/usage 与 kimi /usages 响应,生成测试 fixture。
// 安全:绝不打印 token;响应若含敏感字段在生成时打码。
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const net = require('net');
const tls = require('tls');

const PROXY = 'http://127.0.0.1:7890';

function parseProxy(url) {
  const m = /^https?:\/\/([^:/]+)(?::(\d+))?/.exec(url || '');
  return m ? { host: m[1], port: m[2] ? Number(m[2]) : 80 } : null;
}

function request(url, opts) {
  opts = opts || {};
  const target = new URL(url);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = Object.assign({ 'User-Agent': 'dsm-fixture/1.0' }, opts.headers || {});
  return new Promise((resolve, reject) => {
    const doRequest = (socket) => {
      const req = https.request(
        Object.assign(
          {
            hostname: target.hostname,
            port: target.port || 443,
            path: target.pathname + target.search,
            method,
            headers,
            rejectUnauthorized: true
          },
          socket ? { createConnection: () => socket } : {}
        ),
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('timeout')));
      if (opts.body) req.write(opts.body);
      req.end();
    };
    const p = parseProxy(PROXY);
    if (!p) { doRequest(null); return; }
    const conn = net.connect(p.port, p.host, () => {
      conn.write('CONNECT ' + target.hostname + ':443 HTTP/1.1\r\nHost: ' + target.hostname + ':443\r\n\r\n');
    });
    conn.once('data', (chunk) => {
      const head = chunk.toString('latin1');
      if (!/^HTTP\/1\.[01] 200/i.test(head)) { conn.destroy(); reject(new Error('proxy failed')); return; }
      const tlsSocket = tls.connect({ socket: conn, servername: target.hostname, rejectUnauthorized: true }, () => doRequest(tlsSocket));
      tlsSocket.on('error', reject);
    });
    conn.on('error', reject);
  });
}

// 脱敏:身份/凭据/套餐/时间戳字段一律替换为固定测试值(白名单思路),
// 避免真实账户信息(邮箱/用户 ID/套餐/精确时间)被写进 fixture。
function maskSensitive(obj) {
  return JSON.parse(JSON.stringify(obj, (key, value) => {
    if (typeof value === 'string') {
      if (/token|secret|jwt/i.test(key)) return '***REDACTED***';
      if (/email/i.test(key)) return 'user@example.com';
      if (/^(user_?id|account_?id|org_?id|organization|user)$/i.test(key)) return 'user-ExampleUserId0000000000';
      if (/^plan_?type$/i.test(key)) return 'pro';
      if (value.length > 40 && /[.\-]/.test(value)) return '***REDACTED***';
      return value;
    }
    if (typeof value === 'number' && /reset|expire|time|_at$/i.test(key)) return 1786000000;
    return value;
  }));
}

async function fetchCodex() {
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  if (!fs.existsSync(authPath)) { console.log('codex auth.json 不存在, 跳过'); return; }
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const res = await request('https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      'Authorization': 'Bearer ' + auth.tokens.access_token,
      'ChatGPT-Account-Id': auth.tokens.account_id,
      'User-Agent': 'codex_cli_rs/0.46.0'
    }
  });
  console.log('wham/usage ->', res.status);
  if (res.status === 200) {
    const masked = maskSensitive(JSON.parse(res.body));
    fs.writeFileSync('test/fixtures/codex-wham-usage.json', JSON.stringify(masked, null, 2));
    console.log('saved test/fixtures/codex-wham-usage.json');
  } else {
    console.log('request failed, status', res.status);
  }
}

async function fetchKimi() {
  const credPath = path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json');
  if (!fs.existsSync(credPath)) { console.log('kimi credentials 不存在, 跳过'); return; }
  const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const res = await request('https://api.kimi.com/coding/v1/usages', {
    headers: { 'Authorization': 'Bearer ' + cred.access_token }
  });
  console.log('kimi /usages ->', res.status);
  if (res.status === 200) {
    const masked = maskSensitive(JSON.parse(res.body));
    fs.writeFileSync('test/fixtures/kimi-usages.json', JSON.stringify(masked, null, 2));
    console.log('saved test/fixtures/kimi-usages.json');
  } else {
    console.log('request failed, status', res.status);
  }
}

(async function () {
  await fetchCodex();
  await fetchKimi();
})();
