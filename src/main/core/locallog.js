// localLog 通道核心:增量文件扫描 + 按日聚合(纯函数可测)。
const fs = require('fs');
const path = require('path');

const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

function incrementDiagnostic(diagnostics, key) {
  if (!diagnostics || typeof diagnostics !== 'object') return;
  diagnostics[key] = (Number(diagnostics[key]) || 0) + 1;
}

function evaluationTimeMs(value) {
  const now = Number(value);
  return Number.isFinite(now) ? now : Date.now();
}

function normalizeTimestampMs(value, nowMs) {
  const ts = Number(value);
  const now = evaluationTimeMs(nowMs);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) return null;
  if (ts < MIN_TIMESTAMP_MS || ts > now + MAX_FUTURE_SKEW_MS) return null;
  return ts;
}

// 本地时区日期键 'YYYY-MM-DD'(与 fetcher 的 localTodayStr 同款逻辑)。
function localTzSec() {
  return -new Date().getTimezoneOffset() * 60;
}

function localDayStr(tsMs) {
  return new Date(tsMs + localTzSec() * 1000).toISOString().slice(0, 10);
}

function walkFiles(root, match) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    entries.forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (match.test(entry.name)) out.push(full);
    });
  };
  walk(root);
  return out;
}

// 增量扫描:只读自上次 offset 起的新字节。游标存 { path: { offset, mtimeMs } }(store 键 cursorKey)。
// 文件截断(stat.size < offset)或轮换(mtime 变小)→ offset 回退 0。末尾无换行的不完整行不消费,等补齐后再读。
// 注意:offset 是字节偏移,消费长度必须按 Buffer.byteLength 计算,不能按字符数。
// 返回 UsageRecord[] 行记录(带 provider 标记)。完整但无效的行仍会推进游标。
function scanFiles({
  root,
  match,
  cursorStore,
  cursorKey,
  providerId,
  parseLine,
  diagnostics,
  nowMs
}) {
  const records = [];
  if (!root || !fs.existsSync(root)) return records;

  const evaluationNowMs = evaluationTimeMs(nowMs);
  const cursors = cursorStore.get(cursorKey) || {};
  const files = walkFiles(root, match);

  files.forEach((filePath) => {
    const cursor = cursors[filePath] || { offset: 0, mtimeMs: 0 };
    let stat;
    try { stat = fs.statSync(filePath); } catch (e) { return; }

    let offset = cursor.offset || 0;
    // 截断(文件变小)或轮换(mtime 回退)→ 从头重读
    if (stat.size < offset || (cursor.mtimeMs && stat.mtimeMs < cursor.mtimeMs)) offset = 0;

    if (stat.size <= offset) {
      cursors[filePath] = { offset: offset, mtimeMs: stat.mtimeMs };
      return;
    }

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);

    const text = buf.toString('utf8');
    let consumText = text;
    if (!text.endsWith('\n')) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) {
        // 整个 chunk 都是不完整行,不消费
        cursors[filePath] = { offset: offset, mtimeMs: stat.mtimeMs };
        return;
      }
      consumText = text.slice(0, lastNl + 1);
    }
    // '\n' 是单字节,不会落在多字节字符中间,前缀的 UTF-8 字节数即精确消费偏移
    const consumedBytes = Buffer.byteLength(consumText, 'utf8');

    consumText.split('\n').forEach((line) => {
      if (!line) return;
      const rec = parseLine(line, diagnostics, evaluationNowMs);
      if (rec) records.push(Object.assign({ provider: providerId }, rec));
    });

    cursors[filePath] = { offset: offset + consumedBytes, mtimeMs: stat.mtimeMs };
  });

  Object.keys(cursors).forEach((p) => {
    if (!fs.existsSync(p)) delete cursors[p];
  });
  cursorStore.set(cursorKey, cursors);

  return records;
}

// 纯函数:records → { '<provider>:<YYYY-MM-DD>': { input, cached, output, total } }。
// total 缺失时按 input+output 推导。无效时间戳直接跳过,绝不回退到当前时间。
function rollupDaily(records, diagnostics, nowMs) {
  const out = {};
  const evaluationNowMs = evaluationTimeMs(nowMs);
  (records || []).forEach((rec) => {
    const ts = normalizeTimestampMs(rec && rec.ts, evaluationNowMs);
    if (ts === null) {
      incrementDiagnostic(diagnostics, 'invalidTimestamp');
      return;
    }
    const day = localDayStr(ts);
    const key = rec.provider + ':' + day;
    const entry = out[key] || { input: 0, cached: 0, output: 0, total: 0 };
    const usage = rec.usage || {};
    entry.input += Number(usage.input) || 0;
    entry.cached += Number(usage.cached) || 0;
    entry.output += Number(usage.output) || 0;
    entry.total += Number(usage.total) || (Number(usage.input) || 0) + (Number(usage.output) || 0);
    out[key] = entry;
  });
  return out;
}

module.exports = {
  scanFiles,
  rollupDaily,
  localDayStr,
  localTzSec,
  walkFiles,
  normalizeTimestampMs,
  incrementDiagnostic,
  MIN_TIMESTAMP_MS,
  MAX_FUTURE_SKEW_MS
};
