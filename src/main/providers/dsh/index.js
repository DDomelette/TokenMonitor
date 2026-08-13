// DSH Provider 适配器(localLog 通道:DSH usage 遥测文件)。
const { readLocalLog, resolveTelemetryRoot } = require('./telemetrylog');

module.exports = {
  id: 'dsh',
  displayName: 'DeepSeek Harness',
  capabilities: { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false },

  authStatus() {
    // 本地遥测文件无需凭证。
    return 'ok';
  },

  localLogRoot(ctx) {
    return resolveTelemetryRoot(ctx && ctx.store, process.env);
  },

  readLocalLog
};
