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

test('occupied base port falls back to an available subsequent port', async (t) => {
  const blocker = net.createServer();
  let basePort;
  do {
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', () => { blocker.removeListener('error', reject); resolve(); });
    });
    basePort = blocker.address().port;
    if (basePort > 65525) await new Promise((resolve) => blocker.close(resolve));
  } while (basePort > 65525);
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const srv = await startMcpServer({ basePort, maxPort: basePort + 10, token: TOKEN, handlers });
  t.after(() => srv.close());
  assert.ok(srv.port > basePort && srv.port <= basePort + 10);
  assert.equal(srv.url, 'http://127.0.0.1:' + srv.port + '/mcp');
});
