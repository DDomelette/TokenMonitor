// DSH usage 遥测文件解析 + 根目录解析。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const {
  normalizeTimestampMs,
  incrementDiagnostic,
  localDayStr
} = require('../../core/locallog');
const { calcDshCost } = require('../../pricing');

const fsp = fs.promises;

// $DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl
const DEFAULT_ROOT = () => path.join(os.homedir(), '.dsh', 'telemetry');
// 校验月(01-12)与日(01-31),拒绝 usage-2026-13-99.jsonl 之类非法日期名。
const MATCH = /^usage-\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\.jsonl$/;
const CURSOR_KEY = 'localLogCursors.dsh';

// 遥测根目录优先级:设置项 providers.dsh.telemetryRoot > DSH_HOME 环境变量 > ~/.dsh/telemetry。
function resolveTelemetryRoot(store, env) {
  const custom = store && typeof store.get === 'function' ? store.get('providers.dsh.telemetryRoot') : undefined;
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  const dshHome = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (dshHome) return path.join(dshHome, 'telemetry');
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
    // 费用按原始四桶计算(与 UsageRecord 映射独立,不重复计费)。
    cost: calcDshCost(model, input, output, cacheRead, cacheWrite)
  };
  record.eventFingerprint = 'sha256:' + crypto.createHash('sha256')
    .update([
      new Date(ts).toISOString(),
      input,
      output,
      cacheRead,
      cacheWrite
    ].join('\0'), 'utf8')
    .digest('hex');
  return record;
}

module.exports = {
  parseTelemetryLine,
  resolveTelemetryRoot,
  DEFAULT_ROOT,
  MATCH,
  CURSOR_KEY,
  localDayStr
};
