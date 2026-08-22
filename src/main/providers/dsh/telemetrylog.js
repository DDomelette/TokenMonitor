// DSH usage 遥测文件解析 + 根目录解析。
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scanCandidateBatch,
  walkFiles,
  incrementDiagnostic
} = require('../../core/locallog');
const { parseTelemetryLine, rollupDshRecords } = require('./usage-records');

const fsp = fs.promises;

// $DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl
const DEFAULT_ROOT = () => path.join(os.homedir(), '.dsh', 'telemetry');
// 校验月(01-12)与日(01-31),拒绝 usage-2026-13-99.jsonl 之类非法日期名。
const MATCH = /^usage-\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\.jsonl$/;
const CURSOR_KEY = 'localLogCursors.dsh';

// 遥测根目录优先级:设置项 providers.dsh.telemetryRoot > DSH_HOME 环境变量 > ~/.dsh/telemetry。
// 与 DSH 生产者 resolveDshHome 对齐:支持 ~ / ~/ / ~\ 前缀展开并 resolve 为绝对路径,
// 否则用户按 DSH 文档设 DSH_HOME=~/dsh 或相对路径时,两边指向不同目录、静默无数据。
function expandHomePath(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveTelemetryRoot(store, env) {
  const custom = store && typeof store.get === 'function' ? store.get('providers.dsh.telemetryRoot') : undefined;
  if (typeof custom === 'string' && custom.trim()) return path.resolve(expandHomePath(custom.trim()));
  const dshHome = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (dshHome) return path.resolve(expandHomePath(dshHome), 'telemetry');
  return DEFAULT_ROOT();
}

function cloneStoreValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Deep-compare cursor maps (file identity keys, stable JSON serialization).
// This identifies cursor advancement that must be persisted after a scan.
function cursorsChanged(stored, next) {
  return JSON.stringify(stored || {}) !== JSON.stringify(next || {});
}

// 快照式原子提交:usageDaily、usageDailyCost 与游标同属一份持久单元
// (仿 codex commitUuidScanState;electron-store 的 store 快照替换失败时退化为逐键提交)。
function commitTelemetryScanState(store, usageDaily, usageDailyCost, cursors) {
  const snapshot = store && store.store;
  if (snapshot && typeof snapshot === 'object') {
    const copy = cloneStoreValue(snapshot);
    copy.usageDaily = usageDaily;
    copy.usageDailyCost = usageDailyCost;
    copy.localLogCursors = Object.assign(
      copy.localLogCursors && typeof copy.localLogCursors === 'object' ? copy.localLogCursors : {},
      { dsh: cursors }
    );
    store.store = copy;
    return;
  }
  // 回退路径(electron-store 无 store.store 快照时):单次多键 set 一次落盘
  // (conf.set(object) 逐个应用键后整体 _write);dot 键 localLogCursors.dsh
  // 写入嵌套路径且保留其他 provider 游标。失败时同样单次多键 set 还原三键
  // (含游标),消除三次独立 set 之间的崩溃窗口。
  const previous = {
    'usageDaily': cloneStoreValue(store.get('usageDaily')) || {},
    'usageDailyCost': cloneStoreValue(store.get('usageDailyCost')) || {},
    [CURSOR_KEY]: cloneStoreValue(store.get(CURSOR_KEY)) || {}
  };
  try {
    store.set({
      'usageDaily': usageDaily,
      'usageDailyCost': usageDailyCost,
      [CURSOR_KEY]: cursors
    });
  } catch (error) {
    try {
      store.set(previous);
    } catch (_) { /* 保留原始提交失败 */ }
    throw error;
  }
}

// 扫描单根目录下的 usage-*.jsonl:稳定身份 = 完整路径。
// 增量路径不做内容指纹去重:usageDaily/usageDailyCost 与游标随单次原子提交
// 同单元落盘,"游标落后于数据"的重放态不可达;而 attempt 级行可能字节完全相同
// (同毫秒、同会话、同模型、同四桶的双 attempt),按 lastEventFingerprint 去重会
// 误杀真实的第二行导致漏计。seenFingerprints 分支仅供显式重建(全量去重)使用。
async function scanTelemetryBatch({ store, root, parseLine, diagnostics, nowMs, chunkBytes, maxBytesPerScan, yieldToLoop, seenFingerprints }) {
  const cursors = cloneStoreValue((store && store.get(CURSOR_KEY)) || {});
  const files = await walkFiles(root, MATCH);
  const candidates = files.map((filePath) => ({
    identity: filePath,
    filePath: filePath,
    cursor: cursors[filePath] || { offset: 0, mtimeMs: 0 }
  }));

  const result = await scanCandidateBatch({
    candidates,
    parseLine,
    onRecord({ record, cursor, records }) {
      if (record && record.eventFingerprint) {
        let emit = true;
        if (seenFingerprints) {
          if (seenFingerprints.has(record.eventFingerprint)) {
            incrementDiagnostic(diagnostics, 'duplicateEvent');
            emit = false;
          } else {
            seenFingerprints.add(record.eventFingerprint);
          }
        }
        if (emit) records.push(Object.assign({ provider: 'dsh' }, record));
      }
      return cursor;
    },
    resetCursor(cursor, stat) {
      return { offset: 0, mtimeMs: stat.mtimeMs };
    },
    setCursor(candidate, cursor) {
      cursors[candidate.identity] = cursor;
    },
    diagnostics,
    nowMs,
    chunkBytes,
    maxBytesPerScan,
    yieldToLoop
  });

  return Object.assign({}, result, { cursors });
}

// 异步增量扫描遥测文件:返回 ScanBatch({ records, complete, bytesRead });
// 并按日聚合增量合并进 store 键 'usageDaily' 与 'usageDailyCost'(仅 dsh 前缀)。
async function readLocalLog(ctx, opts) {
  const store = ctx && ctx.store;
  const diagnostics = opts && opts.diagnostics;
  const requestedNowMs = opts && opts.nowMs;
  const parsedNowMs = Number(requestedNowMs);
  const nowMs = requestedNowMs !== null
    && requestedNowMs !== undefined
    && Number.isFinite(parsedNowMs)
    ? parsedNowMs
    : Date.now();
  const root = resolveTelemetryRoot(store, process.env);
  // Persist only new records or cursor advancement; empty scans do not rewrite the store.
  const storedCursors = (store && store.get(CURSOR_KEY)) || {};
  const batch = await scanTelemetryBatch({
    store,
    root,
    parseLine: parseTelemetryLine,
    diagnostics,
    nowMs,
    chunkBytes: opts && opts.chunkBytes,
    maxBytesPerScan: opts && opts.maxBytesPerScan,
    yieldToLoop: opts && opts.yieldToLoop,
    seenFingerprints: opts && opts.seenFingerprints
  });
  const records = batch.records;
  let usageDaily = cloneStoreValue((store && store.get('usageDaily')) || {});
  let usageDailyCost = cloneStoreValue((store && store.get('usageDailyCost')) || {});
  if (records.length && store) {
    const { filterUsageDaily } = require('../../core/usage-retention');
    const rolledAll = rollupDshRecords(records, diagnostics, nowMs);
    const daily = opts && opts.retainAll
      ? rolledAll.usageDaily
      : filterUsageDaily(rolledAll.usageDaily, store.get('data.historyDays'), nowMs);
    Object.keys(daily).forEach((key) => {
      const prev = usageDaily[key] || { input: 0, cached: 0, output: 0, total: 0 };
      const add = daily[key];
      usageDaily[key] = {
        input: prev.input + add.input,
        cached: prev.cached + add.cached,
        output: prev.output + add.output,
        total: prev.total + add.total
      };
    });

    const costDaily = opts && opts.retainAll
      ? rolledAll.usageDailyCost
      : filterUsageDaily(rolledAll.usageDailyCost, store.get('data.historyDays'), nowMs);
    Object.keys(costDaily).forEach((key) => {
      usageDailyCost[key] = Number(usageDailyCost[key] || 0) + Number(costDaily[key]);
    });
    commitTelemetryScanState(store, usageDaily, usageDailyCost, batch.cursors || {});
  } else if (store && cursorsChanged(storedCursors, batch.cursors)) {
    // Persist cursor advancement even when a scan emits no records.
    commitTelemetryScanState(store, usageDaily, usageDailyCost, batch.cursors || {});
  }
  return batch;
}

module.exports = {
  parseTelemetryLine,
  resolveTelemetryRoot,
  readLocalLog,
  scanTelemetryBatch,
  DEFAULT_ROOT,
  MATCH,
  CURSOR_KEY
};
