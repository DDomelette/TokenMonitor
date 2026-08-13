// Codex rollout-*.jsonl 行解析 + 本地日志通道读取。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const {
  scanCandidateBatch,
  scanFileBatch,
  rollupDaily,
  normalizeTimestampMs,
  incrementDiagnostic,
  walkFiles
} = require('../../core/locallog');
const { filterUsageDaily } = require('../../core/usage-retention');

const fsp = fs.promises;
const HEAD_BYTES_CAP = 4096;

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

function cloneStoreValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function storeSnapshot(store) {
  if (!store) return null;
  const snapshot = store.store;
  return snapshot && typeof snapshot === 'object'
    ? cloneStoreValue(snapshot)
    : null;
}

function commitUuidScanState(store, usageDaily, cursors) {
  const snapshot = storeSnapshot(store);
  if (snapshot) {
    snapshot.usageDaily = usageDaily;
    const localLogCursors = snapshot.localLogCursors
      && typeof snapshot.localLogCursors === 'object'
      ? snapshot.localLogCursors
      : {};
    localLogCursors.codex = cursors;
    snapshot.localLogCursors = localLogCursors;
    store.store = snapshot;
    return;
  }
  const previousUsageDaily = cloneStoreValue((store && store.get('usageDaily')) || {});
  try {
    store.set('usageDaily', usageDaily);
    store.set(CURSOR_KEY, cursors);
  } catch (error) {
    try {
      store.set('usageDaily', previousUsageDaily);
    } catch (_) { /* Preserve the original commit failure. */ }
    throw error;
  }
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

// 读取文件头固定前缀的 SHA-256 指纹。byteLength 为 0 或读不到任何字节时返回 null。
async function readHeadHash(filePath, byteLength) {
  if (!byteLength || byteLength <= 0) return null;
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
    if (!bytesRead) return null;
    return 'sha256:' + crypto.createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
  } finally {
    await handle.close();
  }
}

function candidateSourceRank(source) {
  return source === 'active' ? 0 : 1;
}

// 候选排序:size 最大优先,其次活动目录优先,最后路径字典序。
function compareCandidates(a, b) {
  if (b.size !== a.size) return b.size - a.size;
  const rankDiff = candidateSourceRank(a.source) - candidateSourceRank(b.source);
  if (rankDiff !== 0) return rankDiff;
  return a.filePath.localeCompare(b.filePath);
}

// 续扫候选为空时的排序:能承接旧 offset 的优先,其次 size 最大、活动优先、路径字典序。
function compareConflictCandidates(a, b) {
  if (a.canCarry !== b.canCarry) return a.canCarry ? -1 : 1;
  return compareCandidates(a, b);
}

// 为新文件/替换文件构造全新游标:offset 0,headBytes=min(4096, size)。
async function freshCursor(candidate) {
  const headBytes = Math.min(HEAD_BYTES_CAP, candidate.size);
  const headFingerprint = headBytes > 0
    ? await readHeadHash(candidate.filePath, headBytes)
    : null;
  return {
    offset: 0,
    mtimeMs: candidate.mtimeMs,
    size: candidate.size,
    headBytes: headBytes,
    headFingerprint: headFingerprint,
    lastEventFingerprint: null
  };
}

// 完整枚举活动/归档两个根目录,按稳定身份分组并 stat 每个候选。
// roots 可为数组或 { activeRoot, archiveRoot }。
async function collectRolloutCandidates(roots) {
  const sources = [];
  if (Array.isArray(roots)) {
    roots.forEach((root, index) => {
      if (root) sources.push({ root: root, source: index === 0 ? 'active' : 'archive' });
    });
  } else if (roots && typeof roots === 'object') {
    if (roots.activeRoot) sources.push({ root: roots.activeRoot, source: 'active' });
    if (roots.archiveRoot) sources.push({ root: roots.archiveRoot, source: 'archive' });
  }

  const byIdentity = new Map();
  for (const { root, source } of sources) {
    const files = await walkFiles(root, MATCH);
    for (const filePath of files) {
      const identity = rolloutIdentity(filePath);
      let stat;
      try {
        stat = await fsp.stat(filePath);
      } catch (_) {
        continue;
      }
      const candidate = { filePath, size: stat.size, mtimeMs: stat.mtimeMs, source };
      if (!byIdentity.has(identity)) byIdentity.set(identity, []);
      byIdentity.get(identity).push(candidate);
    }
  }

  const groups = [];
  for (const [identity, candidates] of byIdentity) {
    groups.push({ identity, candidates });
  }
  groups.sort((a, b) => a.identity.localeCompare(b.identity));
  return groups;
}

// 为单个身份选择候选并确定游标。返回 { filePath, cursor, conflict, replaced }。
async function selectRolloutCandidate(identity, candidates, cursor) {
  if (!candidates || candidates.length === 0) return null;

  if (!cursor) {
    const chosen = [...candidates].sort(compareCandidates)[0];
    return {
      filePath: chosen.filePath,
      cursor: await freshCursor(chosen),
      conflict: false,
      replaced: true
    };
  }

  const offset = Number(cursor.offset) || 0;
  const persistedHeadBytes = Number(cursor.headBytes) || 0;
  const continuation = [];
  for (const candidate of candidates) {
    if (candidate.size < offset) continue;
    if (persistedHeadBytes > 0) {
      const hash = await readHeadHash(candidate.filePath, persistedHeadBytes);
      if (hash !== cursor.headFingerprint) continue;
    }
    continuation.push(candidate);
  }

  const conflict = continuation.length < candidates.length;

  if (continuation.length > 0) {
    const chosen = continuation.sort(compareCandidates)[0];
    // 连续性已证明:可安全地把 head 前缀扩展到 min(4096, size) 并更新两个 head 字段。
    const next = Object.assign({}, cursor);
    next.size = chosen.size;
    next.mtimeMs = chosen.mtimeMs;
    const headBytes = Math.min(HEAD_BYTES_CAP, chosen.size);
    if (headBytes > 0) {
      next.headBytes = headBytes;
      next.headFingerprint = await readHeadHash(chosen.filePath, headBytes);
    } else {
      next.headBytes = 0;
      next.headFingerprint = null;
    }
    return { filePath: chosen.filePath, cursor: next, conflict, replaced: false };
  }

  // 续扫候选为空:记录安全诊断,按确定顺序选择并重置为 offset 0。
  const ranked = candidates
    .map((candidate) => Object.assign({}, candidate, {
      canCarry: candidate.size >= offset
    }))
    .sort(compareConflictCandidates);
  const chosen = ranked[0];
  return {
    filePath: chosen.filePath,
    cursor: await freshCursor(chosen),
    conflict: true,
    replaced: true
  };
}

// 联合扫描活动/归档两个根目录的 Codex rollout。
// mode === 'legacy' 使用旧的单目录路径游标行为;mode === 'uuid' 按稳定身份枚举两个
// 根目录并持久化 per-UUID 游标。只修改所选游标存储并返回 records;由 readLocalLog
// 负责把 records 汇总进 usageDaily。
async function scanCodexLogBatch({
  store,
  mode,
  diagnostics,
  nowMs,
  chunkBytes,
  maxBytesPerScan,
  yieldToLoop,
  seenFingerprints,
  openCandidate,
  deferCursorCommit
}) {
  const roots = resolveCodexLogRoots(store);
  const activeRoot = roots.activeRoot;
  const archiveRoot = roots.archiveRoot;

  if (mode === 'legacy') {
    return scanFileBatch({
      root: activeRoot,
      match: MATCH,
      cursorStore: store,
      cursorKey: CURSOR_KEY,
      providerId: 'codex',
      parseLine: parseRolloutLine,
      diagnostics,
      nowMs,
      chunkBytes,
      maxBytesPerScan,
      yieldToLoop
    });
  }

  const cursors = cloneStoreValue((store && store.get(CURSOR_KEY)) || {});
  const groups = await collectRolloutCandidates([activeRoot, archiveRoot]);

  const selected = [];
  for (const group of groups) {
    const selection = await selectRolloutCandidate(
      group.identity,
      group.candidates,
      cursors[group.identity] || null
    );
    if (selection && selection.conflict) {
      incrementDiagnostic(diagnostics, 'headConflict');
    }
    selected.push({
      identity: group.identity,
      filePath: selection.filePath,
      cursor: selection.cursor
    });
  }

  const openWithRetry = async (candidate) => {
    try {
      return openCandidate
        ? await openCandidate(candidate)
        : await fsp.open(candidate.filePath, 'r');
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
      const recollected = await collectRolloutCandidates([activeRoot, archiveRoot]);
      const group = recollected.find((item) => item.identity === candidate.identity);
      if (!group || group.candidates.length === 0) return null;
      const selection = await selectRolloutCandidate(
        candidate.identity,
        group.candidates,
        candidate.cursor
      );
      candidate.filePath = selection.filePath;
      try {
        return await fsp.open(selection.filePath, 'r');
      } catch (retryError) {
        if (retryError && retryError.code === 'ENOENT') return null;
        throw retryError;
      }
    }
  };

  const result = await scanCandidateBatch({
    candidates: selected,
    parseLine: parseRolloutLine,
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
        if (emit) {
          records.push(Object.assign({ provider: 'codex' }, record));
        }
        cursor.lastEventFingerprint = fingerprint;
      }
      return cursor;
    },
    isReplaced: async (candidate, cursor, stat) => {
      if (stat.size < (Number(cursor.offset) || 0)) return true;
      if (cursor.headBytes > 0) {
        const hash = await readHeadHash(candidate.filePath, cursor.headBytes);
        if (hash !== cursor.headFingerprint) return true;
      }
      return false;
    },
    computeHead: async (candidate, stat) => {
      const headBytes = Math.min(HEAD_BYTES_CAP, stat.size);
      const headFingerprint = headBytes > 0
        ? await readHeadHash(candidate.filePath, headBytes)
        : null;
      return { headBytes, headFingerprint };
    },
    resetCursor(cursor, stat, headInfo) {
      return {
        offset: 0,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        headBytes: headInfo ? headInfo.headBytes : 0,
        headFingerprint: headInfo ? headInfo.headFingerprint : null,
        lastEventFingerprint: null
      };
    },
    setCursor(candidate, cursor) {
      cursors[candidate.identity] = cursor;
    },
    openCandidate: openWithRetry,
    diagnostics,
    nowMs,
    chunkBytes,
    maxBytesPerScan,
    yieldToLoop
  });

  // 游标清理使用两个根目录身份的完整并集,只在完整枚举完成后进行。
  const presentIdentities = new Set(groups.map((group) => group.identity));
  for (const identity of Object.keys(cursors)) {
    if (!presentIdentities.has(identity)) delete cursors[identity];
  }
  if (!deferCursorCommit) store.set(CURSOR_KEY, cursors);
  return deferCursorCommit
    ? Object.assign({}, result, { cursors })
    : result;
}

// 异步增量扫描本机 codex 日志,返回 ScanBatch({ records, complete, bytesRead });
// 并按日聚合增量合并进 store 键 'usageDaily'。mode 显式给定则优先;否则仅当迁移标记
// codexArchiveUuidCursorV1 === true 时使用 UUID 双目录模式,缺失时退回 legacy 模式。
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
  const mode = opts && opts.mode !== undefined
    ? opts.mode
    : ((store && store.get('localLogMigrations.codexArchiveUuidCursorV1') === true)
      ? 'uuid'
      : 'legacy');
  const batch = await scanCodexLogBatch({
    store,
    mode,
    diagnostics,
    nowMs,
    chunkBytes: opts && opts.chunkBytes,
    maxBytesPerScan: opts && opts.maxBytesPerScan,
    yieldToLoop: opts && opts.yieldToLoop,
    seenFingerprints: opts && opts.seenFingerprints,
    openCandidate: opts && opts.openCandidate,
    deferCursorCommit: mode === 'uuid'
  });
  const records = batch.records;
  let usageDaily = cloneStoreValue((store && store.get('usageDaily')) || {});
  if (records.length && store) {
    // retainAll:全量重扫(历史同步)时绕过保留窗口过滤,否则旧日聚合在写入前即被丢弃
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
  }
  if (store && mode === 'uuid') {
    commitUuidScanState(store, usageDaily, batch.cursors || {});
  } else if (records.length && store) {
    store.set('usageDaily', usageDaily);
  }
  return batch;
}

module.exports = {
  parseRolloutLine,
  readLocalLog,
  scanCodexLogBatch,
  collectRolloutCandidates,
  selectRolloutCandidate,
  DEFAULT_ROOT,
  DEFAULT_ARCHIVE_ROOT,
  MATCH,
  rolloutIdentity,
  codexEventFingerprint,
  resolveCodexLogRoots
};
