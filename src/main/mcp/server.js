// MCP Streamable HTTP 服务(stateless):仅 loopback + Host 白名单 + Bearer 鉴权。
// 纯 node http,无 express;每请求新建 McpServer + transport。
const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { registerMcpTools } = require('./tools');

const LOOPBACK_HOST_PATTERN = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function createRequestHandler(token, handlers) {
  return async (req, res) => {
    try {
      if (!LOOPBACK_HOST_PATTERN.test(req.headers.host || '')) {
        send(res, 403, 'Forbidden');
        return;
      }
      if (req.url !== '/mcp' || req.method !== 'POST') {
        send(res, 404, 'Not Found');
        return;
      }
      if (req.headers.authorization !== 'Bearer ' + token) {
        send(res, 401, 'Unauthorized');
        return;
      }
      const body = await readBody(req);
      // stateless:每请求独立 server + transport,无会话状态
      const mcpServer = new McpServer({ name: 'tokenmonitor', version: '1.0.0' });
      registerMcpTools(mcpServer, handlers);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) send(res, 500, 'Internal Server Error');
      else res.end();
    }
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

async function startMcpServer(options) {
  const basePort = options.basePort;
  const maxPort = options.maxPort || (basePort ? basePort + 9 : 0);
  const logger = options.logger || console;
  const handler = createRequestHandler(options.token, options.handlers);

  let lastError = null;
  for (let port = basePort; port <= maxPort; port++) {
    const server = http.createServer(handler);
    try {
      // basePort 为 0 时交给系统分配 ephemeral 端口(测试用)
      await listen(server, port || 0);
      const actual = server.address().port;
      if (actual !== basePort && basePort) {
        logger.log('[mcp] port ' + basePort + ' occupied, fallback to ' + actual);
      }
      return {
        port: actual,
        url: 'http://127.0.0.1:' + actual + '/mcp',
        close: () => new Promise((resolve) => server.close(resolve))
      };
    } catch (e) {
      lastError = e;
      try { server.close(); } catch (_) {}
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw lastError || new Error('no available port');
}

module.exports = { startMcpServer };
