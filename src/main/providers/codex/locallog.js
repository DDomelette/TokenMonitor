// Codex rollout-*.jsonl 行解析 + 本地日志通道读取。
const os = require('os');
const path = require('path');
const {
  scanFiles,
  rollupDaily,
  normalizeTimestampMs,
  incrementDiagnostic
} = require('../../core/locallog');
const { filterUsageDaily } = require('../../core/usage-retention');

// ~/.codex/sessions/**/rollout-*.jsonl
const DEFAULT_ROOT = () => path.join(os.homedir(), '.codex', 'sessions');
const MATCH = /rollout-.*\.jsonl$/;
const CURSOR_KEY = 'localLogCursors.codex';

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
    return {
      ts: ts,
      usage: {
        input: last.input_tokens || 0,
        cached: last.cached_input_tokens || 0,
        output: last.output_tokens || 0,
        reasoning: last.reasoning_output_tokens || 0,
        total: last.total_tokens || 0
      }
    };
  } catch (e) {
    return null;
  }
}

// 异步增量扫描本机 codex 日志,返回新增 UsageRecord[];并按日聚合增量合并进 store 键 'usageDaily'。
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
  const batch = await scanFiles({
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

module.exports = { parseRolloutLine, readLocalLog, DEFAULT_ROOT, MATCH };
