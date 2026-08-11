// localLog 通道核心:异步增量文件扫描 + 按日聚合(纯函数可测)。
// 按日聚合使用固定 UTC+8 北京结算日历,不依赖操作系统时区/DST。
const fs = require('fs');
const path = require('path');

const { localDayStr, localTzSec } = require('./beijing-calendar');

const fsp = fs.promises;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCAN_CHUNK_BYTES = 64 * 1024;
const DEFAULT_SCAN_BUDGET_BYTES = 4 * 1024 * 1024;

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

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function defaultYieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch (_) {
    return false;
  }
}

async function walkFiles(root, match) {
  const out = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      match.lastIndex = 0;
      if (match.test(entry.name)) out.push(full);
    }
  }

  if (root) await walk(root);
  return out;
}

// 异步增量扫描:游标存 { path: { offset, mtimeMs } }。每次只分配固定块,并限制单轮总读取量。
// 文件截断或轮换时从头重读;游标只提交到已完整解析(或明确跳过)的换行符之后。
// 若预算在一行中间耗尽,为避免该行永久饥饿,只继续到该行的下一个换行符后停止。
// 返回 ScanBatch { records, complete, bytesRead }:complete=false 表示本轮预算耗尽,
// 还有文件或文件尾部未读,需要下一轮继续;末行无换行符的未完成行不视为不完整。
async function scanFiles({
  root,
  match,
  cursorStore,
  cursorKey,
  providerId,
  parseLine,
  diagnostics,
  nowMs,
  chunkBytes,
  maxBytesPerScan,
  yieldToLoop
}) {
  const records = [];
  if (!root || !(await pathExists(root))) {
    return { records, complete: true, bytesRead: 0 };
  }

  const evaluationNowMs = evaluationTimeMs(nowMs);
  const readChunkBytes = positiveInteger(chunkBytes, DEFAULT_SCAN_CHUNK_BYTES);
  let remainingBudget = positiveInteger(maxBytesPerScan, DEFAULT_SCAN_BUDGET_BYTES);
  let bytesRead = 0;
  let complete = true;
  const yieldBlock = typeof yieldToLoop === 'function' ? yieldToLoop : defaultYieldToLoop;
  const cursors = cursorStore.get(cursorKey) || {};
  const files = await walkFiles(root, match);

  try {
    for (const filePath of files) {
      if (remainingBudget <= 0) {
        complete = false;
        break;
      }

      const cursor = cursors[filePath] || { offset: 0, mtimeMs: 0 };
      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch (_) {
        continue;
      }

      let offset = Number(cursor.offset) || 0;
      if (stat.size < offset || (cursor.mtimeMs && stat.mtimeMs < cursor.mtimeMs)) {
        offset = 0;
      }

      if (stat.size <= offset) {
        cursors[filePath] = { offset, mtimeMs: stat.mtimeMs };
        continue;
      }

      let committedOffset = offset;
      let readPosition = offset;
      let pending = Buffer.alloc(0);
      let handle = null;
      let failure = null;

      try {
        handle = await fsp.open(filePath, 'r');

        while (readPosition < stat.size) {
          if (remainingBudget <= 0 && pending.length === 0) {
            complete = false;
            break;
          }

          const finishingStartedLine = remainingBudget <= 0;
          const fileRemaining = stat.size - readPosition;
          const budgetAllowance = finishingStartedLine
            ? readChunkBytes
            : remainingBudget;
          const readSize = Math.min(readChunkBytes, fileRemaining, budgetAllowance);
          if (readSize <= 0) break;

          const buffer = Buffer.alloc(readSize);
          const result = await handle.read(buffer, 0, readSize, readPosition);
          if (!result.bytesRead) break;

          const chunk = buffer.subarray(0, result.bytesRead);
          readPosition += result.bytesRead;
          bytesRead += result.bytesRead;
          remainingBudget = Math.max(0, remainingBudget - result.bytesRead);
          pending = pending.length
            ? Buffer.concat([pending, chunk])
            : Buffer.from(chunk);

          let lineStart = 0;
          let completedLines = 0;
          while (true) {
            const newlineIndex = pending.indexOf(0x0a, lineStart);
            if (newlineIndex < 0) break;

            const line = pending.subarray(lineStart, newlineIndex).toString('utf8');
            if (line) {
              const record = parseLine(line, diagnostics, evaluationNowMs);
              if (record) records.push(Object.assign({ provider: providerId }, record));
            }

            committedOffset += newlineIndex + 1 - lineStart;
            lineStart = newlineIndex + 1;
            completedLines += 1;
            if (finishingStartedLine) break;
          }

          if (lineStart > 0) {
            pending = Buffer.from(pending.subarray(lineStart));
          }
          cursors[filePath] = { offset: committedOffset, mtimeMs: stat.mtimeMs };

          await yieldBlock();
          if (finishingStartedLine && completedLines > 0) {
            pending = Buffer.alloc(0);
            if (readPosition < stat.size) complete = false;
            break;
          }
          if (remainingBudget <= 0 && pending.length === 0) {
            // 预算恰好在文件末尾耗尽时整文件已读完,不视为不完整
            if (readPosition < stat.size) complete = false;
            break;
          }
        }
      } catch (error) {
        failure = error;
      } finally {
        if (handle) {
          try {
            await handle.close();
          } catch (closeError) {
            if (!failure) failure = closeError;
          }
        }
      }

      cursors[filePath] = { offset: committedOffset, mtimeMs: stat.mtimeMs };
      if (failure) throw failure;
    }
  } catch (error) {
    cursorStore.set(cursorKey, cursors);
    throw error;
  }

  for (const cursorPath of Object.keys(cursors)) {
    if (!(await pathExists(cursorPath))) delete cursors[cursorPath];
  }
  cursorStore.set(cursorKey, cursors);
  return { records, complete, bytesRead };
}

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
  MAX_FUTURE_SKEW_MS,
  DEFAULT_SCAN_CHUNK_BYTES,
  DEFAULT_SCAN_BUDGET_BYTES
};
