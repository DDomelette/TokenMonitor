// MCP 工具/资源:全部只读。handler 为纯 async 函数(可单测),
// registerMcpTools 负责把它们包装成 SDK 的 content 返回形状。
const {
  projectProviders,
  projectRemainingUsage,
  projectModelUsage,
  projectUsageSummary
} = require('./projection');
const { localDayString } = require('../core/usage-retention');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function resolveArgs(args) {
  const a = args || {};
  if (a.provider !== undefined && typeof a.provider !== 'string') {
    throw new Error('provider 必须是字符串');
  }
  if (a.date !== undefined && !DATE_PATTERN.test(a.date)) {
    throw new Error('date 必须是 YYYY-MM-DD');
  }
  return a;
}

function buildToolHandlers(deps) {
  const snapshot = () => deps.getSnapshot() || [];
  const usageDaily = () => deps.getUsageDaily() || {};
  return {
    async listProviders() {
      return projectProviders(snapshot());
    },
    async getRemainingUsage(args) {
      const a = resolveArgs(args);
      return projectRemainingUsage(snapshot(), deps.getState, a.provider);
    },
    async getModelUsage(args) {
      const a = resolveArgs(args);
      return projectModelUsage(usageDaily(), {
        provider: a.provider,
        date: a.date || localDayString(deps.now())
      });
    },
    async getUsageSummary(args) {
      const a = resolveArgs(args);
      return projectUsageSummary(usageDaily(), {
        provider: a.provider,
        date: a.date || localDayString(deps.now())
      });
    },
    async readQuotaResource() {
      return projectRemainingUsage(snapshot(), deps.getState);
    }
  };
}

function asJsonContent(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function registerMcpTools(mcpServer, handlers) {
  mcpServer.registerTool(
    'list_providers',
    { description: '列出全部 Provider 及其认证/数据新鲜度状态' },
    async () => asJsonContent(await handlers.listProviders())
  );
  mcpServer.registerTool(
    'get_remaining_usage',
    { description: '各 Provider 剩余用量:余额(预付)或订阅窗口(used/limit/remaining/resetsAt)。参数: provider(可选)' },
    async (args) => asJsonContent(await handlers.getRemainingUsage(args))
  );
  mcpServer.registerTool(
    'get_model_usage',
    { description: '某日模型级已消耗 tokens(仅 deepseek 提供模型级明细)。参数: provider(可选), date(YYYY-MM-DD,缺省今日)' },
    async (args) => asJsonContent(await handlers.getModelUsage(args))
  );
  mcpServer.registerTool(
    'get_usage_summary',
    { description: '今日(或指定日)各 Provider 用量汇总 input/output/cached/total。参数: provider(可选), date(可选)' },
    async (args) => asJsonContent(await handlers.getUsageSummary(args))
  );
  mcpServer.registerResource(
    'quota',
    'tokenmonitor://quota',
    { description: '全部 Provider 额度快照', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(await handlers.readQuotaResource(), null, 2)
      }]
    })
  );
}

module.exports = { buildToolHandlers, registerMcpTools };
