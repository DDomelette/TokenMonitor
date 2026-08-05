// Kimi wire.jsonl 行解析 + 本地日志通道读取。
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scanFiles,
  rollupDaily,
  normalizeTimestampMs,
  incrementDiagnostic
} = require('../../core/locallog');
const { filterUsageDaily } = require('../../core/usage-retention');

// ~/.kimi-code/sessions/**/wire.jsonl
const DEFAULT_ROOT = () => path.join(os.homedir(), '.kimi-code', 'sessions');
const MATCH = /wire\.jsonl$/;
const CURSOR_KEY = 'localLogCursors.kimi';
// 一次性迁移标记:total 口径改为含缓存后,清掉旧口径聚合与游标,全量重建
const MIGRATION_KEY = 'localLogMigrations.kimiTotalIncludesCached';

// 解析单行:usage.record 行,input=inputOther,cached=inputCacheRead,output=output,ts 取 data.time(epoch ms)。
// total 含缓存读取(与 codex total_tokens / deepseek 平台口径一致),历史旧口径数据由下方迁移重建。
function parseWireLine(line, diagnostics, nowMs) {
  if (!line) return null;
  try {
    const data = JSON.parse(line);
    if (!data || data.type !== 'usage.record' || !data.usage) return null;
    const ts = normalizeTimestampMs(data.time, nowMs);
    if (ts === null) {
      incrementDiagnostic(diagnostics, 'invalidTimestamp');
      return null;
    }
    const usage = data.usage;
    const input = usage.inputOther || 0;
    const cached = usage.inputCacheRead || 0;
    const output = usage.output || 0;
    return {
      ts: ts,
      model: data.model || null,
      usage: {
        input: input,
        cached: cached,
        output: output,
        total: input + cached + output
      }
    };
  } catch (e) {
    return null;
  }
}

// 增量扫描本机 kimi 日志,返回新增 UsageRecord[];并按日聚合增量合并进 store 键 'usageDaily'。
// ctx = { store, ... }。root 可通过 store 键 'providers.kimi.localLogRoot' 覆盖(测试用)。
function readLocalLog(ctx, opts) {
  const store = ctx && ctx.store;
  const diagnostics = opts && opts.diagnostics;
  const nowMs = opts && opts.nowMs;
  const root = (store && store.get('providers.kimi.localLogRoot')) || DEFAULT_ROOT();
  if (store && !store.get(MIGRATION_KEY)) {
    const usageDaily = store.get('usageDaily') || {};
    Object.keys(usageDaily).forEach((key) => {
      if (key.indexOf('kimi:') === 0) delete usageDaily[key];
    });
    store.set('usageDaily', usageDaily);
    store.set(CURSOR_KEY, {});
    store.set(MIGRATION_KEY, true);
  }
  if (!fs.existsSync(root)) return [];
  const records = scanFiles({
    root: root,
    match: MATCH,
    cursorStore: store,
    cursorKey: CURSOR_KEY,
    providerId: 'kimi',
    parseLine: parseWireLine,
    diagnostics: diagnostics,
    nowMs: nowMs
  });
  if (records.length && store) {
    const daily = filterUsageDaily(
      rollupDaily(records, diagnostics, nowMs),
      store.get('data.historyDays')
    );
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
  return records;
}

module.exports = { parseWireLine, readLocalLog, DEFAULT_ROOT, MATCH };
