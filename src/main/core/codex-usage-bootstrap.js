// Codex 用量启动编排:先创建运行时并立即启动影子迁移(不等待),再构造调度器,
// 使调度器对 Codex 的首次 localLog 轮询在迁移 Promise 之后排队。
// 该助手是纯同步组合,不 await 迁移,保证应用就绪流程不被迁移阻塞。
const CODEX_USAGE_BOOTSTRAP_FAILED = 'CODEX_USAGE_BOOTSTRAP_FAILED';

function startCodexUsageBootstrap({ createRuntime, startScheduler, onUnexpectedMigrationError }) {
  const runtime = createRuntime();
  const migrationPromise = runtime.startMigration();
  // startMigration 正常路径总是以安全结果 resolve(失败进入兼容模式),不会 reject;
  // 这里只兜底意外的程序员错误,且只报告常量错误码,绝不输出原始 message 或私有路径。
  migrationPromise.catch(() => {
    if (typeof onUnexpectedMigrationError === 'function') {
      onUnexpectedMigrationError({ code: CODEX_USAGE_BOOTSTRAP_FAILED });
    }
  });
  const scheduler = startScheduler(runtime);
  return { runtime, scheduler, migrationPromise };
}

module.exports = { startCodexUsageBootstrap, CODEX_USAGE_BOOTSTRAP_FAILED };
