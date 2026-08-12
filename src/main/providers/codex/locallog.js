// Codex rollout-*.jsonl 行解析 + 本地日志通道读取。
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const {
  scanFileBatch,
  rollupDaily,
  normalizeTimestampMs,
  incrementDiagnostic
} = require('../../core/locallog');
const { filterUsageDaily } = require('../../core/usage-retention');

// ~/.codex/sessions/**/rollout-*.jsonl
const DEFAULT_ROOT = () => path.join(os.homedir(), '.codex', 'sessions');
const DEFAULT_ARCHIVE_ROOT = () => path.join(os.homedir(), '.codex', 'archived_sessions');
const MATCH = /rollout-.*\.jsonl$/;
const CURSOR_KEY = 'localLogCursors.codex';
// 稳定文件身份:优先取文件名末尾 UUID,退化到完整 basename。
const ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// 从 rollout 文件路径解析稳定身份:标准 UUID 结尾取 UUID,否则取完整 basename。
function rolloutIdentity(filePath) {
  const basename = path.posix.basename(String(filePath).replace(/\\/g, '/'));
  const match = ROLLOUT_UUID_RE.exec(basename);
  return match ? match[1] : basename;
}

// 事件指纹:规范化 timestamp + last_token_usage 数值字段的 SHA-256。
// 缺失的数值字段规范化为零;不包含路径、累计快照、rate_limits、model 等易变元数据。
function codexEventFingerprint(record) {
  if (!record) return null;
  let iso;
  try {
    iso = new Date(record.ts).toISOString();
  } catch (e) {
    return null;
  }
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const material = [
    iso,
    num(record.input),
    num(record.cached),
    num(record.output),
    num(record.reasoning),
    num(record.total)
  ].join('\0');
  const digest = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
  return 'sha256:' + digest;
}

// 解析活动/归档目录设置:自定义活动目录不猜测归档目录,只有显式设置 archivedLogRoot
// 才启用自定义归档;未配置自定义活动目录时默认归档目录自动启用。
function resolveCodexLogRoots(store) {
  const customActive = store && store.get('providers.codex.localLogRoot');
  const customArchive = store && store.get('providers.codex.archivedLogRoot');
  const activeRoot = customActive || DEFAULT_ROOT();
  const archiveRoot = customActive
    ? (customArchive || null)
    : (customArchive || DEFAULT_ARCHIVE_ROOT());
  return { activeRoot: activeRoot, archiveRoot: archiveRoot };
}

// 解析单行:取 payload.info.last_token_usage,timestamp 取 data.timestamp。
function parseRolloutLine(line, diagnostics, nowMs) {
  if (!line) return null;
  try {
    const data = JSON.parse(line);
    if (!data || data.type !== 'event_msg') return null;
    const payload = data.payload;
    if (!payload || payload.type !== 'token_count' || !payload.info) return null;
    const last = payload.info.last_token_usage;
    if (!last) return null;
    const parsedTimestamp = data.timestamp === null || data.timestamp === undefined
      ? null
      : new Date(data.timestamp).getTime();
    const ts = normalizeTimestampMs(parsedTimestamp, nowMs);
    if (ts === null) {
      incrementDiagnostic(diagnostics, 'invalidTimestamp');
      return null;
    }
    const usage = {
      input: last.input_tokens || 0,
      cached: last.cached_input_tokens || 0,
      output: last.output_tokens || 0,
      reasoning: last.reasoning_output_tokens || 0,
      total: last.total_tokens || 0
    };
    return {
      ts: ts,
      usage: usage,
      eventFingerprint: codexEventFingerprint({
        ts: ts,
        input: usage.input,
        cached: usage.cached,
        output: usage.output,
        reasoning: usage.reasoning,
        total: usage.total
      })
    };
  } catch (e) {
    return null;
  }
}

// 异步增量扫描本机 codex 日志,返回 ScanBatch({ records, complete, bytesRead });
// 并按日聚合增量合并进 store 键 'usageDaily'。
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
  const root = (store && store.get('providers.codex.localLogRoot')) || DEFAULT_ROOT();
  const batch = await scanFileBatch({
    root: root,
    match: MATCH,
    cursorStore: store,
    cursorKey: CURSOR_KEY,
    providerId: 'codex',
    parseLine: parseRolloutLine,
    diagnostics: diagnostics,
    nowMs: nowMs,
    chunkBytes: opts && opts.chunkBytes,
    maxBytesPerScan: opts && opts.maxBytesPerScan,
    yieldToLoop: opts && opts.yieldToLoop
  });
  const records = batch.records;
  if (records.length && store) {
    // retainAll:全量重扫(历史同步)时绕过保留窗口过滤,否则旧日聚合在写入前即被丢弃
    const rolled = rollupDaily(records, diagnostics, nowMs);
    const daily = opts && opts.retainAll
      ? rolled
      : filterUsageDaily(rolled, store.get('data.historyDays'), nowMs);
    const usageDaily = store.get('usageDaily') || {};
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
    store.set('usageDaily', usageDaily);
  }
  return batch;
}

module.exports = {
  parseRolloutLine,
  readLocalLog,
  DEFAULT_ROOT,
  DEFAULT_ARCHIVE_ROOT,
  MATCH,
  rolloutIdentity,
  codexEventFingerprint,
  resolveCodexLogRoots
};
