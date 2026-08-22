// Kimi wire.jsonl 行解析 + 本地日志通道读取。
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  scanFileBatch,
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

// 解析日志根目录列表:主目录(自定义 localLogRoot 或默认)
// + providers.kimi.extraLogRoots(用户手动附加)
// + providers.kimi.autoLogRoots(系统扫描自动探测,如 WSL 的
//   \\wsl.localhost\<distro>\home\<user>\.kimi-code\sessions,见 wsl-roots.js)。
// 游标按绝对路径存储,多目录共用 CURSOR_KEY 不会互相干扰。
function resolveKimiLogRoots(store) {
  const custom = store && store.get('providers.kimi.localLogRoot');
  const roots = [custom || DEFAULT_ROOT()];
  ['providers.kimi.extraLogRoots', 'providers.kimi.autoLogRoots'].forEach((key) => {
    const list = store && store.get(key);
    (Array.isArray(list) ? list : []).forEach((r) => {
      const root = typeof r === 'string' ? r.trim() : '';
      if (root && roots.indexOf(root) < 0) roots.push(root);
    });
  });
  return roots;
}

async function pathAccessible(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch (_) {
    return false;
  }
}

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

// 异步增量扫描本机 kimi 日志,返回 ScanBatch({ records, complete, bytesRead });
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
  const roots = resolveKimiLogRoots(store);
  if (store && !store.get(MIGRATION_KEY)) {
    const usageDaily = store.get('usageDaily') || {};
    Object.keys(usageDaily).forEach((key) => {
      if (key.indexOf('kimi:') === 0) delete usageDaily[key];
    });
    store.set('usageDaily', usageDaily);
    store.set(CURSOR_KEY, {});
    store.set(MIGRATION_KEY, true);
  }
  // 附加目录(如 WSL UNC 路径)可能暂时不可达(distro 未运行):
  // scanFileBatch 末尾会清除"文件不存在"的游标,若不加保护,目录恢复后会
  // 从头重扫,把已聚合过的用量再计一遍。这里先备份这些目录下的游标,扫完恢复。
  const accessibleRoots = [];
  const inaccessibleRoots = [];
  for (const root of roots) {
    (await pathAccessible(root) ? accessibleRoots : inaccessibleRoots).push(root);
  }
  const cursorsSnapshot = (store && store.get(CURSOR_KEY)) || {};
  // 深拷贝:scanFileBatch 原地修改并回写同一对象,引用快照会被一起改掉
  const cursorsBefore = JSON.parse(JSON.stringify(cursorsSnapshot));
  const records = [];
  let complete = true;
  let bytesRead = 0;
  for (const root of accessibleRoots) {
    const batch = await scanFileBatch({
      root: root,
      match: MATCH,
      cursorStore: store,
      cursorKey: CURSOR_KEY,
      providerId: 'kimi',
      parseLine: parseWireLine,
      diagnostics: diagnostics,
      nowMs: nowMs,
      chunkBytes: opts && opts.chunkBytes,
      maxBytesPerScan: opts && opts.maxBytesPerScan,
      yieldToLoop: opts && opts.yieldToLoop
    });
    records.push.apply(records, batch.records);
    complete = complete && batch.complete !== false;
    bytesRead += Number(batch.bytesRead) || 0;
  }
  if (store && inaccessibleRoots.length) {
    const cursorsAfter = store.get(CURSOR_KEY) || {};
    Object.keys(cursorsBefore).forEach((filePath) => {
      if (cursorsAfter[filePath] === undefined
        && inaccessibleRoots.some((root) => filePath.indexOf(root) === 0)) {
        cursorsAfter[filePath] = cursorsBefore[filePath];
      }
    });
    store.set(CURSOR_KEY, cursorsAfter);
  }
  const batch = { records, complete, bytesRead };
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

module.exports = { parseWireLine, readLocalLog, resolveKimiLogRoots, DEFAULT_ROOT, MATCH };
