// MCP 服务运行时:装配 token/tools/server,提供开关与连接信息。
const { ensureMcpToken, rotateMcpToken } = require('./token');
const { buildToolHandlers } = require('./tools');
const { startMcpServer } = require('./server');

const BASE_PORT = 29350;
const MAX_PORT = 29359;

function startMCP(deps) {
  const store = deps.store;
  const scheduler = deps.scheduler;
  const logger = deps.logger || console;
  const basePort = deps.basePort != null ? deps.basePort : BASE_PORT;
  const maxPort = deps.maxPort != null ? deps.maxPort : MAX_PORT;
  let server = null;

  const handlers = buildToolHandlers({
    getSnapshot: () => scheduler.getSnapshot(),
    getState: (id) => scheduler.getState(id),
    getUsageDaily: () => store.get('usageDaily'),
    now: () => Date.now()
  });

  function isEnabled() {
    return store.get('mcp.enabled') !== false;
  }

  async function start() {
    if (server || !isEnabled()) return;
    try {
      const token = ensureMcpToken(store);
      server = await startMcpServer({ basePort, maxPort, token, handlers, logger });
      logger.log('[mcp] listening at ' + server.url);
    } catch (e) {
      // MCP 启动失败不阻断主应用
      logger.error('[mcp] failed to start: ' + (e && e.message));
      server = null;
    }
  }

  async function stop() {
    if (!server) return;
    const current = server;
    server = null;
    await current.close();
  }

  return {
    start,
    stop,
    isRunning: () => !!server,
    getConnectionInfo() {
      return {
        enabled: isEnabled(),
        running: !!server,
        port: server ? server.port : null,
        url: server ? server.url : null,
        token: store.get('mcp.token') || null
      };
    },
    async rotateToken() {
      const token = rotateMcpToken(store);
      if (server) {
        await stop();
        await start();
      }
      return token;
    }
  };
}

module.exports = { startMCP, BASE_PORT };
