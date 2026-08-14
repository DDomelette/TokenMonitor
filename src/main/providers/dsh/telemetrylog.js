// DSH usage 遥测文件解析 + 根目录解析。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const {
  scanCandidateBatch,
  rollupDaily,
  walkFiles,
  normalizeTimestampMs,
  incrementDiagnostic,
  localDayStr
} = require('../../core/locallog');
const { calcDshCost, getDshModelPrice } = require('../../pricing');

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

// 解析一行遥测 JSON。任何非法行返回 null 并计诊断;绝不伪造时间戳。
function parseTelemetryLine(line, diagnostics, nowMs) {
  if (!line) return null;
  let data;
  try {
    data = JSON.parse(line);
  } catch (e) {
    incrementDiagnostic(diagnostics, 'malformedLine');
    return null;
  }
  if (!data || typeof data !== 'object') {
    incrementDiagnostic(diagnostics, 'malformedLine');
    return null;
  }
  if (data.v === undefined) {
    incrementDiagnostic(diagnostics, 'missingRowVersion');
    return null;
  }
  if (data.v !== 1) {
    incrementDiagnostic(diagnostics, 'unknownRowVersion');
    return null;
  }
  const ts = normalizeTimestampMs(data.time, nowMs);
  if (ts === null) {
    incrementDiagnostic(diagnostics, 'invalidTimestamp');
    return null;
  }
  const input = Number(data.inputTokens);
  const output = Number(data.outputTokens);
  const cacheRead = Number(data.cacheReadTokens) || 0;
  const cacheWrite = Number(data.cacheWriteTokens) || 0;
  const buckets = [input, output, cacheRead, cacheWrite];
  if (!buckets.every((n) => Number.isSafeInteger(n) && n >= 0)) {
    incrementDiagnostic(diagnostics, 'invalidTokenCount');
    return null;
  }
  const model = typeof data.model === 'string' && data.model.length > 0 ? data.model : 'unknown';
  const sessionId = typeof data.sessionId === 'string' && data.sessionId.length > 0 ? data.sessionId : 'unknown';
  // 未知模型(查无单价)按设计规格记 0 费用并计诊断,避免静默按 pro 单价错估。
  if (!getDshModelPrice(model, ts)) {
    incrementDiagnostic(diagnostics, 'unknownModel');
  }
  const record = {
    ts: ts,
    model: model,
    // UsageRecord 映射:input 含 cacheWrite(按输入计费),cached = cacheRead。
    usage: {
      input: input + cacheWrite,
      cached: cacheRead,
      output: output,
      total: input + cacheWrite + cacheRead + output
    },
    // 费用按原始四桶计算(与 UsageRecord 映射独立,不重复计费);未知模型为 0。
    cost: calcDshCost(model, input, output, cacheRead, cacheWrite, ts)
  };
  record.eventFingerprint = 'sha256:' + crypto.createHash('sha256')
    .update([
      new Date(ts).toISOString(),
      sessionId,
      model,
      input,
      output,
      cacheRead,
      cacheWrite
    ].join('\0'), 'utf8')
    .digest('hex');
  return record;
}

function cloneStoreValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// 深比较两组游标(键为文件完整路径,JSON 序列化稳定)。仅用于判断"扫描是否产生任何
// 需要落盘的变化"(游标推进/过期条目 GC),避免空扫描每 60s 无条件全量重写 store。
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

// 扫描单根目录下的 usage-*.jsonl:稳定身份 = 完整路径;onRecord 内做事件指纹去重
// (游标提交失败重扫时,已提交行之前的最后一条会被重读,指纹相同即跳过)。
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
        const fingerprint = record.eventFingerprint;
        let emit = true;
        if (seenFingerprints) {
          if (seenFingerprints.has(fingerprint)) {
            incrementDiagnostic(diagnostics, 'duplicateEvent');
            emit = false;
          } else {
            seenFingerprints.add(fingerprint);
          }
        } else if (cursor.lastEventFingerprint === fingerprint) {
          incrementDiagnostic(diagnostics, 'duplicateEvent');
          emit = false;
        }
        if (emit) records.push(Object.assign({ provider: 'dsh' }, record));
        cursor.lastEventFingerprint = fingerprint;
      }
      return cursor;
    },
    resetCursor(cursor, stat) {
      return { offset: 0, mtimeMs: stat.mtimeMs, lastEventFingerprint: null };
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

  for (const identity of Object.keys(cursors)) {
    if (!files.includes(identity)) delete cursors[identity];
  }
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
  // 扫描前的已存游标:仅当扫描后游标集合相对它实际变化(推进/GC)或产生新记录时才提交,
  // 否则空扫描(根缺失、无新行、无过期条目)完全不碰 store,避免每 60s 整库克隆+落盘。
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
    const rolled = rollupDaily(records, diagnostics, nowMs);
    const daily = opts && opts.retainAll
      ? rolled
      : filterUsageDaily(rolled, store.get('data.historyDays'), nowMs);
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

    const costRolled = {};
    records.forEach((rec) => {
      const day = localDayStr(rec.ts);
      const key = 'dsh:' + day;
      costRolled[key] = Number(costRolled[key] || 0) + Number(rec.cost || 0);
    });
    const costDaily = opts && opts.retainAll
      ? costRolled
      : filterUsageDaily(costRolled, store.get('data.historyDays'), nowMs);
    Object.keys(costDaily).forEach((key) => {
      usageDailyCost[key] = Number(usageDailyCost[key] || 0) + Number(costDaily[key]);
    });
    commitTelemetryScanState(store, usageDaily, usageDailyCost, batch.cursors || {});
  } else if (store && cursorsChanged(storedCursors, batch.cursors)) {
    // 无新记录但游标集合变化(游标推进/过期条目 GC):同样必须提交,否则每轮重解析或残留死条目。
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
  CURSOR_KEY,
  localDayStr
};
