const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { startMcpServer } = require('../src/main/mcp/server');

const TOKEN = 'test-token-123';
const handlers = {
  async listProviders() { return []; },
  async getRemainingUsage() { return []; },
  async getModelUsage() { return []; },
  async getUsageSummary() { return []; },
  async readQuotaResource() { return []; }
};

function post(port, { token, host, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Host': host || ('127.0.0.1:' + port),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }
};

test('missing or wrong bearer token gets 401', async (t) => {
  const srv = await startMcpServer({ basePort: 0, token: TOKEN, handlers });
  t.after(() => srv.close());
  assert.equal((await post(srv.port, { body: INIT })).status, 401);
  assert.equal((await post(srv.port, { token: 'wrong', body: INIT })).status, 401);
});

test('non-loopback Host gets 403', async (t) => {
  const srv = await startMcpServer({ basePort: 0, token: TOKEN, handlers });
  t.after(() => srv.close());
  const res = await post(srv.port, { token: TOKEN, host: 'evil.example.com', body: INIT });
  assert.equal(res.status, 403);
});

test('valid token initializes the MCP session and names server tokenmonitor', async (t) => {
  const srv = await startMcpServer({ basePort: 0, token: TOKEN, handlers });
  t.after(() => srv.close());
  const res = await post(srv.port, { token: TOKEN, body: INIT });
  assert.equal(res.status, 200);
  assert.match(res.body, /tokenmonitor/);
});

test('occupied base port falls back to basePort + 1', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(45950, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const srv = await startMcpServer({ basePort: 45950, maxPort: 45952, token: TOKEN, handlers });
  t.after(() => srv.close());
  assert.equal(srv.port, 45951);
  assert.equal(srv.url, 'http://127.0.0.1:45951/mcp');
});
