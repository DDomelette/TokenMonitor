// localLog 通道核心:异步增量文件扫描 + 按日聚合(纯函数可测)。
const fs = require('fs');
const path = require('path');

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

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localTzSec(tsMs = Date.now()) {
  return -new Date(tsMs).getTimezoneOffset() * 60;
}

function localDayStr(tsMs) {
  const date = new Date(tsMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
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

// 通用候选扫描原语:接收按序排列的候选快照 [{ identity, filePath, cursor }],
// 通过注入的回调获取/提交游标,只在每个完整换行之后提交游标,累计 bytesRead,
// 并按 Task 1 的规则返回 complete。解析失败时只提交失败行之前的完整换行边界。
// onRecord({ record, cursor, identity, records }) 决定发出/跳过并返回下一游标元数据;
// 当 size/head 证明文件被替换时调用 resetCursor(cursor, stat, headInfo) 生成从头读取的游标。
async function scanCandidateBatch({
  candidates,
  parseLine,
  onRecord,
  resetCursor,
  setCursor,
  isReplaced,
  computeHead,
  openCandidate,
  getCursor,
  diagnostics,
  nowMs,
  chunkBytes,
  maxBytesPerScan,
  yieldToLoop
}) {
  const records = [];
  const evaluationNowMs = evaluationTimeMs(nowMs);
  const readChunkBytes = positiveInteger(chunkBytes, DEFAULT_SCAN_CHUNK_BYTES);
  let remainingBudget = positiveInteger(maxBytesPerScan, DEFAULT_SCAN_BUDGET_BYTES);
  const yieldBlock = typeof yieldToLoop === 'function' ? yieldToLoop : defaultYieldToLoop;
  let complete = true;
  let bytesRead = 0;

  for (const candidate of candidates || []) {
    if (remainingBudget <= 0) {
      complete = false;
      break;
    }

    const identity = candidate.identity;
    let cursor = getCursor ? await getCursor(candidate) : candidate.cursor;
    if (!cursor) cursor = { offset: 0, mtimeMs: 0 };

    let stat;
    try {
      stat = await fsp.stat(candidate.filePath);
    } catch (_) {
      continue;
    }

    let replaced;
    if (isReplaced) {
      replaced = await isReplaced(candidate, cursor, stat);
    } else {
      const legacyOffset = Number(cursor.offset) || 0;
      replaced = stat.size < legacyOffset
        || (cursor.mtimeMs && stat.mtimeMs < cursor.mtimeMs);
    }

    let workingCursor = cursor;
    if (replaced) {
      const headInfo = computeHead ? await computeHead(candidate, stat) : null;
      workingCursor = await resetCursor(cursor, stat, headInfo);
    }

    const offset = Number(workingCursor.offset) || 0;
    if (stat.size <= offset) {
      workingCursor.mtimeMs = stat.mtimeMs;
      await setCursor(candidate, workingCursor);
      continue;
    }

    let committedOffset = offset;
    let readPosition = offset;
    let pending = Buffer.alloc(0);
    let handle = null;
    let failure = null;

    try {
      handle = openCandidate
        ? await openCandidate(candidate)
        : await fsp.open(candidate.filePath, 'r');
      if (!handle) continue;

      while (readPosition < stat.size) {
        if (remainingBudget <= 0 && pending.length === 0) break;

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
          let record = null;
          if (line) {
            record = parseLine(line, diagnostics, evaluationNowMs);
          }

          committedOffset += newlineIndex + 1 - lineStart;
          lineStart = newlineIndex + 1;
          completedLines += 1;

          workingCursor.offset = committedOffset;
          workingCursor.mtimeMs = stat.mtimeMs;
          workingCursor = await onRecord({
            record,
            cursor: workingCursor,
            identity,
            records
          });

          if (finishingStartedLine) break;
        }

        if (lineStart > 0) {
          pending = Buffer.from(pending.subarray(lineStart));
        }
        await setCursor(candidate, workingCursor);

        await yieldBlock();
        if (finishingStartedLine && completedLines > 0) {
          // 完成已开始的行后,丢弃的尾块若仍含完整换行,说明还有未提交的完整行,
          // 本轮必须标记未完成,避免全量重建在 readPosition 已到 EOF 时误判完成。
          if (pending.length > 0 && pending.indexOf(0x0a) >= 0) complete = false;
          pending = Buffer.alloc(0);
          break;
        }
        if (remainingBudget <= 0 && pending.length === 0) break;
      }

      // 到达 EOF 后仍未提交的字节只能是缺少换行的尾行,不算未完成;
      // 其余情况(预算耗尽仍剩可读字节)标记本轮未完成。
      if (readPosition < stat.size) complete = false;
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

    await setCursor(candidate, workingCursor);
    if (failure) throw failure;
  }

  return { records, complete, bytesRead };
}

// 兼容包装:单目录路径游标扫描(Kimi 与旧版 Codex 行为)。
async function scanFileBatch({
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
  if (!root || !(await pathExists(root))) {
    return { records: [], complete: true, bytesRead: 0 };
  }

  const cursors = cursorStore.get(cursorKey) || {};
  const files = await walkFiles(root, match);
  const candidates = files.map((filePath) => ({
    identity: filePath,
    filePath: filePath,
    cursor: cursors[filePath] || { offset: 0, mtimeMs: 0 }
  }));

  let result;
  try {
    result = await scanCandidateBatch({
      candidates,
      parseLine,
      onRecord({ record, cursor, records }) {
        if (record) records.push(Object.assign({ provider: providerId }, record));
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
  } catch (error) {
    cursorStore.set(cursorKey, cursors);
    throw error;
  }

  for (const cursorPath of Object.keys(cursors)) {
    if (!(await pathExists(cursorPath))) delete cursors[cursorPath];
  }
  cursorStore.set(cursorKey, cursors);
  return result;
}

// 兼容包装:现有单目录调用方在本任务期间仍取 records 数组。
async function scanFiles(options) {
  return (await scanFileBatch(options)).records;
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
  scanCandidateBatch,
  scanFileBatch,
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
