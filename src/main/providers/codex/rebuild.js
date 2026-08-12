// Codex 归档日志用量的事务性影子重建。
// 先在独立内存影子 store 中联合扫描活动/归档两个目录,得到完整 codex:* 日汇总与
// UUID 游标,再通过一次 `store.store = nextStore` 提交,绝不分步写入。
const { rollupDaily } = require('../../core/locallog');
const { scanCodexLogBatch } = require('./locallog');

const CODEX_ARCHIVE_MIGRATION_KEY = 'localLogMigrations.codexArchiveUuidCursorV1';
const CODEX_MIGRATION_FIELD = 'codexArchiveUuidCursorV1';
const CURSOR_KEY = 'localLogCursors.codex';
const USAGE_DAILY_KEY = 'usageDaily';
const CODEX_PREFIX = 'codex:';
const MAX_CODEX_REBUILD_PASSES = 10000;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

// 最小内存影子 store:平铺点号键,get/set 只按完整键读写,供扫描器复用。
function makeShadowStore(initial) {
  const data = Object.assign({}, initial);
  return {
    get(key) { return data[key]; },
    set(key, value) { data[key] = value; },
    data
  };
}

function mergeDaily(target, additions) {
  const out = target || {};
  Object.keys(additions || {}).forEach((key) => {
    const prev = out[key] || { input: 0, cached: 0, output: 0, total: 0 };
    const add = additions[key];
    out[key] = {
      input: prev.input + add.input,
      cached: prev.cached + add.cached,
      output: prev.output + add.output,
      total: prev.total + add.total
    };
  });
  return out;
}

function buildSummary(usageDaily, passes, records, diagnostics, bytesRead) {
  const dayRe = /^codex:(\d{4}-\d{2}-\d{2})$/;
  let daysRebuilt = 0;
  let earliestDate = null;
  Object.keys(usageDaily || {}).forEach((key) => {
    const match = dayRe.exec(key);
    if (match) {
      daysRebuilt += 1;
      if (!earliestDate || match[1] < earliestDate) earliestDate = match[1];
    }
  });
  return {
    daysRebuilt,
    earliestDate,
    passes,
    records,
    duplicates: (diagnostics && diagnostics.duplicateEvent) || 0,
    bytesRead
  };
}

// 联合扫描活动/归档目录,在影子 store 上完成全量事件级去重重建。
// 返回 { usageDaily, cursors, summary },全程不接触真实 store。
async function buildCodexShadow({
  activeRoot,
  archiveRoot,
  nowMs,
  chunkBytes,
  maxBytesPerScan,
  maxPasses,
  scanBatch,
  onProgress
}) {
  const shadow = makeShadowStore({
    [USAGE_DAILY_KEY]: {},
    [CURSOR_KEY]: {},
    [CODEX_ARCHIVE_MIGRATION_KEY]: true,
    'providers.codex.localLogRoot': activeRoot,
    'providers.codex.archivedLogRoot': archiveRoot
  });

  const scan = scanBatch || scanCodexLogBatch;
  const limit = positiveInteger(maxPasses, MAX_CODEX_REBUILD_PASSES);
  const seenFingerprints = new Set();
  const diagnostics = {};

  let passes = 0;
  let records = 0;
  let bytesRead = 0;
  let complete = false;

  while (passes < limit) {
    passes += 1;
    const batch = await scan({
      store: shadow,
      mode: 'uuid',
      diagnostics,
      nowMs,
      chunkBytes,
      maxBytesPerScan,
      seenFingerprints
    });

    const batchRecords = (batch && batch.records) || [];
    records += batchRecords.length;
    bytesRead += Number(batch && batch.bytesRead) || 0;

    shadow.set(
      USAGE_DAILY_KEY,
      mergeDaily(shadow.get(USAGE_DAILY_KEY), rollupDaily(batchRecords, diagnostics, nowMs))
    );

    complete = !!(batch && batch.complete);
    if (typeof onProgress === 'function') {
      onProgress({ passes, records, bytesRead, complete });
    }
    if (complete) break;
  }

  if (!complete) {
    const error = new Error('Codex local log rebuild incomplete');
    error.code = 'LOCAL_LOG_RESCAN_INCOMPLETE';
    error.providerId = 'codex';
    error.passes = passes;
    error.records = records;
    error.bytesRead = bytesRead;
    throw error;
  }

  const usageDaily = shadow.get(USAGE_DAILY_KEY) || {};
  const cursors = shadow.get(CURSOR_KEY) || {};
  return {
    usageDaily,
    cursors,
    summary: buildSummary(usageDaily, passes, records, diagnostics, bytesRead)
  };
}

function cloneStoreData(value) {
  if (value === undefined || value === null) return {};
  return JSON.parse(JSON.stringify(value));
}

// 提交影子重建:读取提交瞬间的最新 store.store,只替换 codex:* 与 Codex 游标/
// 迁移标记,其它行原样保留,并通过一次 `store.store = nextStore` 原子写入。
function replaceCodexSnapshot(store, shadow) {
  const nextStore = cloneStoreData(store && store.store);

  const usageDaily = nextStore[USAGE_DAILY_KEY]
    && typeof nextStore[USAGE_DAILY_KEY] === 'object'
    ? nextStore[USAGE_DAILY_KEY]
    : {};
  Object.keys(usageDaily).forEach((key) => {
    if (key.indexOf(CODEX_PREFIX) === 0) delete usageDaily[key];
  });
  Object.keys((shadow && shadow.usageDaily) || {}).forEach((key) => {
    usageDaily[key] = shadow.usageDaily[key];
  });
  nextStore[USAGE_DAILY_KEY] = usageDaily;

  const localLogCursors = nextStore.localLogCursors
    && typeof nextStore.localLogCursors === 'object'
    ? nextStore.localLogCursors
    : {};
  localLogCursors.codex = (shadow && shadow.cursors) || {};
  nextStore.localLogCursors = localLogCursors;

  const localLogMigrations = nextStore.localLogMigrations
    && typeof nextStore.localLogMigrations === 'object'
    ? nextStore.localLogMigrations
    : {};
  localLogMigrations[CODEX_MIGRATION_FIELD] = true;
  nextStore.localLogMigrations = localLogMigrations;

  store.store = nextStore;
}

// 构建影子状态后提交,返回 summary。
async function rebuildCodexUsage({ store, ...buildOptions }) {
  const shadow = await buildCodexShadow(buildOptions);
  replaceCodexSnapshot(store, shadow);
  return shadow.summary;
}

module.exports = {
  CODEX_ARCHIVE_MIGRATION_KEY,
  MAX_CODEX_REBUILD_PASSES,
  buildCodexShadow,
  replaceCodexSnapshot,
  rebuildCodexUsage
};
