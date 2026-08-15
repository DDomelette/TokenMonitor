// DSH usage 行对象 → UsageRecord 映射 + 日聚合 rollup。
// 文件扫描(telemetrylog)与 HTTP ingest 共用本模块,禁止两处实现不同口径。
const crypto = require('node:crypto');
const {
  normalizeTimestampMs,
  localDayStr,
  rollupDaily,
  incrementDiagnostic
} = require('../../core/locallog');
const { calcDshCost, getDshModelPrice } = require('../../pricing');

function mapRowObjectToRecord(data, diagnostics, nowMs) {
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
  if (typeof data.time !== 'number' || !Number.isSafeInteger(data.time)) {
    incrementDiagnostic(diagnostics, 'invalidTimestamp');
    return null;
  }
  const ts = normalizeTimestampMs(data.time, nowMs);
  if (ts === null) {
    incrementDiagnostic(diagnostics, 'invalidTimestamp');
    return null;
  }
  if (typeof data.sessionId !== 'string' || data.sessionId.length === 0) {
    incrementDiagnostic(diagnostics, 'invalidSessionId');
    return null;
  }
  if (data.model !== undefined && typeof data.model !== 'string') {
    incrementDiagnostic(diagnostics, 'invalidModel');
    return null;
  }
  if (data.cwd !== undefined && typeof data.cwd !== 'string') {
    incrementDiagnostic(diagnostics, 'invalidCwd');
    return null;
  }
  const input = data.inputTokens;
  const output = data.outputTokens;
  const cacheRead = data.cacheReadTokens === undefined ? 0 : data.cacheReadTokens;
  const cacheWrite = data.cacheWriteTokens === undefined ? 0 : data.cacheWriteTokens;
  if (![input, output, cacheRead, cacheWrite]
    .every((n) => Number.isSafeInteger(n) && n >= 0)) {
    incrementDiagnostic(diagnostics, 'invalidTokenCount');
    return null;
  }
  const model = typeof data.model === 'string' && data.model.length > 0 ? data.model : 'unknown';
  const sessionId = data.sessionId;
  if (!getDshModelPrice(model, ts)) {
    incrementDiagnostic(diagnostics, 'unknownModel');
  }
  const record = {
    ts: ts,
    model: model,
    currency: 'CNY',
    usage: {
      input: input + cacheWrite,
      cached: cacheRead,
      output: output,
      total: input + cacheWrite + cacheRead + output
    },
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

function parseTelemetryLine(line, diagnostics, nowMs) {
  if (!line) return null;
  let data;
  try {
    data = JSON.parse(line);
  } catch (_) {
    incrementDiagnostic(diagnostics, 'malformedLine');
    return null;
  }
  return mapRowObjectToRecord(data, diagnostics, nowMs);
}

function rollupDshRecords(records, diagnostics, nowMs) {
  // rollupDaily 依赖 rec.provider 拼键;文件扫描会在外层补 provider,ingest 不会,
  // 这里统一补 'dsh',保证两个入口同键。
  const withProvider = (records || []).map((rec) => Object.assign({}, rec, { provider: 'dsh' }));
  const usageDaily = rollupDaily(withProvider, diagnostics, nowMs);
  const usageDailyCost = {};
  withProvider.forEach((rec) => {
    const ts = normalizeTimestampMs(rec && rec.ts, nowMs);
    if (ts === null) return;
    const key = 'dsh:' + localDayStr(ts);
    usageDailyCost[key] = Number(usageDailyCost[key] || 0) + Number(rec.cost || 0);
  });
  return { usageDaily, usageDailyCost };
}

module.exports = { mapRowObjectToRecord, parseTelemetryLine, rollupDshRecords };
