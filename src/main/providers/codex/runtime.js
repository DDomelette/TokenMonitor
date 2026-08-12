// Codex 用量运行时协调器:单一 FIFO 写队列 + 启动影子迁移 + 失败兼容回退。
// 所有 Codex 写操作(启动迁移、手动重建、增量扫描)共用一条 Promise 尾队列,
// 保证同一时刻只有一个 Codex 写入者;Kimi 与其它 provider 通道互不影响。
const {
  rebuildCodexUsage: defaultRebuildCodexUsage,
  CODEX_ARCHIVE_MIGRATION_KEY
} = require('./rebuild');
const { readLocalLog } = require('./locallog');

const SAFE_CODE_RE = /^[A-Z][A-Z0-9_:-]{0,63}$/;
const FALLBACK_CODE = 'CODEX_ARCHIVE_MIGRATION_FAILED';
const STOPPED_CODE = 'CODEX_RUNTIME_STOPPED';

// 只接受安全错误码;否则退回通用安全码。绝不外泄原始 message 或私有路径。
function safeErrorCode(error) {
  const code = error && error.code;
  return typeof code === 'string' && SAFE_CODE_RE.test(code)
    ? code
    : FALLBACK_CODE;
}

function codedError(code) {
  const error = new Error('Codex usage migration failed');
  error.code = code;
  return error;
}

function stoppedError() {
  const error = new Error('Codex usage runtime stopped');
  error.code = STOPPED_CODE;
  return error;
}

function createCodexUsageRuntime(options = {}) {
  const store = options.store;
  const rebuildCodexUsage = options.rebuildCodexUsage || defaultRebuildCodexUsage;
  const incrementalScan = options.incrementalScan
    || ((opts) => readLocalLog({ store }, opts));
  const baseBuildOptions = options.buildOptions || {};
  const logger = options.logger || null;

  // 迁移标记已提交 => 直接 ready;否则 idle,等待 startMigration。
  let phase = (store && store.get(CODEX_ARCHIVE_MIGRATION_KEY) === true) ? 'ready' : 'idle';
  let migrationPending = false;
  let migrationPromise = null;
  let lastErrorCode = null;
  let catchUpErrorCode = null;
  let tail = Promise.resolve();

  // 链在 tail 之后,把 tail 更新为吞掉拒绝的完成 Promise 以维持队列连续,
  // 返回真实的操作 Promise。
  function enqueue(operation) {
    const run = tail.then(() => operation());
    tail = run.then(() => undefined, () => undefined);
    return run;
  }

  // 在每个排队增量操作真正开始时才决定 UUID/legacy,而不是入队时决定。
  function currentScanMode() {
    return phase === 'ready' ? 'uuid' : 'legacy';
  }

  function reportPreCommitFailure(code) {
    lastErrorCode = code;
    if (phase !== 'stopped') phase = 'compatibility';
    if (logger) logger({ code, phase: 'compatibility' });
  }

  // 共享影子重建 + 补扫。区分提交边界:rebuildCodexUsage 返回前失败(影子扫描
  // 或 store 提交)说明迁移标记尚不存在 => 启动进入兼容模式,手动重试保持兼容并
  // 抛安全错误。rebuildCodexUsage 一旦返回即提交成功 => 先置 ready 再 UUID 补扫;
  // 补扫失败只记录 catchUpErrorCode 且保持 ready,由下一次 UUID 扫描从已提交游标续扫。
  async function runShadowRebuildAndCatchUp({ rejectOnFailure, rebuildOptions }) {
    let summary;
    try {
      summary = await rebuildCodexUsage(
        Object.assign({}, baseBuildOptions, rebuildOptions || {}, { store })
      );
    } catch (error) {
      const code = safeErrorCode(error);
      reportPreCommitFailure(code);
      if (rejectOnFailure) throw codedError(code);
      return { migrated: false, skipped: false, errorCode: code };
    }

    if (phase !== 'stopped') phase = 'ready';
    try {
      await incrementalScan({ mode: 'uuid' });
    } catch (error) {
      catchUpErrorCode = safeErrorCode(error);
      if (logger) logger({ code: catchUpErrorCode, phase: 'ready' });
      if (rejectOnFailure) return summary;
      return { migrated: true, skipped: false, summary, catchUpErrorCode };
    }
    if (rejectOnFailure) return summary;
    return { migrated: true, skipped: false, summary };
  }

  // 非 async,直接返回存储的 Promise,保证重复调用 Promise 身份一致。
  function startMigration() {
    if (phase === 'stopped') return Promise.reject(stoppedError());
    if (phase === 'ready') return Promise.resolve({ migrated: true, skipped: true });
    if (!migrationPromise) {
      migrationPending = true;
      if (phase !== 'stopped') phase = 'migrating';
      migrationPromise = enqueue(() =>
        runShadowRebuildAndCatchUp({ rejectOnFailure: false })
      );
      migrationPromise.then(
        () => { migrationPending = false; },
        () => { migrationPending = false; }
      );
    }
    return migrationPromise;
  }

  function runIncremental(fn) {
    if (phase === 'stopped') return Promise.reject(stoppedError());
    if (typeof fn !== 'function') {
      return Promise.reject(new TypeError('Codex incremental scan function required'));
    }
    return enqueue(() => fn({ mode: currentScanMode() }));
  }

  async function rebuild(options) {
    if (migrationPending && migrationPromise) {
      const result = await migrationPromise;
      if (result.summary) return result.summary;
      throw codedError(result.errorCode || FALLBACK_CODE);
    }
    if (phase === 'stopped') throw stoppedError();
    return enqueue(() =>
      runShadowRebuildAndCatchUp({ rejectOnFailure: true, rebuildOptions: options })
    );
  }

  function getStatus() {
    return {
      phase,
      migrationPending,
      compatibilityMode: phase === 'compatibility',
      lastErrorCode
    };
  }

  function stop() {
    if (phase !== 'stopped') phase = 'stopped';
  }

  return { startMigration, runIncremental, rebuild, getStatus, stop };
}

module.exports = { createCodexUsageRuntime, safeErrorCode };
