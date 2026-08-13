// 历史用量同步:DeepSeek 逐月全量回填 + Codex/Kimi 本机日志全量重扫。
// 纯逻辑模块,依赖全部注入,便于 node --test 直测。
const { retentionStartDay, localDayString } = require('./usage-retention');

const MAX_MONTHS = 36;
// 连续空月停止阈值:12,容忍使用量稀疏的长间隔(曾有 5/6 月空、4 月有数据的真实案例)
const EMPTY_STREAK_STOP = 12;
const MONTH_GAP_MS = 300;
const MAX_SCAN_PASSES = 10000;
// 全量同步自己的月份标记:不能用 backfill 的 providers.deepseek.fetchedMonths——
// backfill 抓取时 persistDaily 会按保留窗口丢弃旧日数据,月份却照标"已抓",
// 信任它会让被丢弃的月份永远不再抓(数据永久缺失)。
const SYNCED_MONTHS_KEY = 'providers.deepseek.syncedMonths';
// 本标记自身也有同样陷阱:保留窗口清理会删日数据但不删标记(2026-08 真实案例:
// 标记 2023-09 起全齐,数据只剩 7 月,重同步全部跳过)。因此"有数据月份"标记
// 必须与 usageDaily 实际数据共存才可信;真正抓过且无数据的月份单独记在这里。
const EMPTY_MONTHS_KEY = 'providers.deepseek.syncedEmptyMonths';
// 粒度再细一层:月份可能被"部分清理"(如 7 月 1-12 日删了、13 日起还在),
// "标记+有数据"会让整月可信被跳过,窗口内的空洞永久显示 0(真实案例二)。
// 这里记录每月同步时的窗口起点(无窗口时为 'FULL'):可信 = 覆盖起点不晚于
// 当前窗口对该月的需求起点;无记录的老标记用"该月现存最早日"兜底推断。
const COVERAGE_KEY = 'providers.deepseek.syncedCoverage';

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function monthKey(y, m) {
  return y + '-' + String(m).padStart(2, '0');
}

async function fetchMonthWithRetry(fetchMonth, year, month) {
  try {
    return await fetchMonth(year, month);
  } catch (e) {
    return fetchMonth(year, month);
  }
}

// 从当月起逐月向前回填:连续 12 空月停止,硬上限 36 个月;
// 同名 'deepseek:<date>' 键以 API 数据直接覆盖(幂等,API 为准)。
// 跳过规则:整月落在保留窗口外 => 直接终止(不抓不标记,窗口调大后可补抓);
// 数据月:标记+数据仍在+覆盖范围满足当前窗口 => 跳过;空月:标记+覆盖满足 => 跳过;
// 其余(数据被清/部分被清/窗口调大后覆盖不足/从未抓过)=> 重新抓取。
// 每次抓取后把当月覆盖范围更新为当前窗口起点(无窗口时 'FULL')。
async function syncDeepSeekHistory(options) {
  const fetchMonth = options.fetchMonth;
  const readStore = options.readStore;
  const writeStore = options.writeStore;
  const onProgress = options.onProgress || null;
  const sleep = options.sleep || defaultSleep;
  const current = options.now ? new Date(options.now) : new Date();
  let year = current.getFullYear();
  let month = current.getMonth() + 1;

  const usageDaily = readStore('usageDaily') || {};
  const syncedMonths = new Set(readStore(SYNCED_MONTHS_KEY) || []);
  const emptyMonths = new Set(readStore(EMPTY_MONTHS_KEY) || []);
  const coverage = Object.assign({}, readStore(COVERAGE_KEY) || {});
  // 保留窗口起点(本地日历日,含,与本次同步的 now 对齐);未设置保留天数时不做窗口过滤
  const cutoff = retentionStartDay(readStore('data.historyDays'), current.getTime());
  // usageDaily 中实际有数据的 deepseek 月份(抓取写入时同步更新),
  // 及每月现存最早日(无覆盖记录的老标记的兜底推断依据)
  const dataMonths = new Set();
  const monthEarliest = new Map();
  let earliestDate = null;
  Object.keys(usageDaily).forEach((k) => {
    const m = /^deepseek:(\d{4}-\d{2})-(\d{2})$/.exec(k);
    if (m) {
      dataMonths.add(m[1]);
      const day = k.slice(9);
      if (!monthEarliest.has(m[1]) || day < monthEarliest.get(m[1])) monthEarliest.set(m[1], day);
      if (!earliestDate || day < earliestDate) earliestDate = day;
    }
  });

  // 该月已知覆盖是否满足当前窗口:窗口对该月的需求起点 = max(cutoff, 月首),
  // 已知覆盖起点(显式记录,否则兜底=现存最早日)不晚于它即视为覆盖充足。
  function monthCoversWindow(key) {
    if (!cutoff) return true;
    const recorded = coverage[key];
    if (recorded === 'FULL') return true;
    const monthStart = key + '-01';
    const demand = cutoff > monthStart ? cutoff : monthStart;
    const known = recorded || monthEarliest.get(key) || null;
    return !!known && known <= demand;
  }

  let monthsFetched = 0;
  const monthsFailed = [];
  let emptyStreak = 0;

  for (let i = 0; i < MAX_MONTHS && emptyStreak < EMPTY_STREAK_STOP; i++) {
    const key = monthKey(year, month);
    // 月份按新到旧迭代,整月(new Date(y, m, 0) = 该月最后一天)落在窗口外时,
    // 更老的月份必然也在窗外,直接终止。
    if (cutoff && localDayString(new Date(year, month, 0).getTime()) < cutoff) break;
    const trusted = (syncedMonths.has(key) && dataMonths.has(key) && monthCoversWindow(key))
      || (emptyMonths.has(key) && monthCoversWindow(key));
    if (!trusted) {
      let daily = null;
      try {
        daily = await fetchMonthWithRetry(fetchMonth, year, month);
      } catch (e) {
        monthsFailed.push(key);
      }
      if (daily) {
        monthsFetched++;
        const days = (Array.isArray(daily) ? daily : []).filter(
          (d) => d && d.date && Math.round(Number(d.total) || 0) > 0
            && (!cutoff || d.date >= cutoff)
        );
        if (!days.length) {
          emptyStreak++;
          emptyMonths.add(key);
          syncedMonths.delete(key);
        } else {
          emptyStreak = 0;
          days.forEach((d) => {
            usageDaily['deepseek:' + d.date] = {
              input: 0,
              cached: Math.round(Number(d.cacheHit) || 0),
              output: 0,
              total: Math.round(Number(d.total) || 0),
              models: (d.models || []).map((m) => ({ model: m.model, tokens: m.tokens }))
            };
            if (!earliestDate || d.date < earliestDate) earliestDate = d.date;
            if (!monthEarliest.has(key) || d.date < monthEarliest.get(key)) monthEarliest.set(key, d.date);
          });
          dataMonths.add(key);
          syncedMonths.add(key);
          emptyMonths.delete(key);
        }
        coverage[key] = cutoff || 'FULL';
      }
      if (onProgress) onProgress({ stage: 'deepseek', detail: key });
      await sleep(MONTH_GAP_MS);
    }
    month--;
    if (month === 0) {
      month = 12;
      year--;
    }
  }

  writeStore('usageDaily', usageDaily);
  writeStore(SYNCED_MONTHS_KEY, Array.from(syncedMonths));
  writeStore(EMPTY_MONTHS_KEY, Array.from(emptyMonths));
  writeStore(COVERAGE_KEY, coverage);
  return { monthsFetched, monthsFailed, earliestDate };
}

// 全量重扫本机日志:先删该 provider 的 usageDaily 键并清游标(增量合并会重复累加,
// 必须先行清除,先例见 src/main/providers/kimi/locallog.js 的 MIGRATION_KEY 流程),
// 再循环调用 readLocalLog 直到 batch.complete === true(scanFileBatch 单轮有 4MB 预算,全量需多轮)。
// 事务性:清空前深拷贝匹配的 provider 行与游标;任何失败都还原二者后重抛。
async function rescanLocalLogs(options) {
  const providerId = options.providerId;
  const readLocalLog = options.readLocalLog;
  const readStore = options.readStore;
  const writeStore = options.writeStore;
  const deleteStore = options.deleteStore;
  const onProgress = options.onProgress || null;
  const maxPasses = options.maxPasses || MAX_SCAN_PASSES;

  const prefix = providerId + ':';
  const cursorKey = 'localLogCursors.' + providerId;

  function cloneValue(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  const usageDaily = readStore('usageDaily') || {};
  const backupRows = {};
  Object.keys(usageDaily).forEach((k) => {
    if (k.indexOf(prefix) === 0) backupRows[k] = cloneValue(usageDaily[k]);
  });
  const backupCursor = cloneValue(readStore(cursorKey));

  let passes = 0;
  let records = 0;
  let bytesRead = 0;
  let complete = false;

  try {
    const clearedDaily = cloneValue(usageDaily);
    Object.keys(clearedDaily).forEach((k) => {
      if (k.indexOf(prefix) === 0) delete clearedDaily[k];
    });
    writeStore('usageDaily', clearedDaily);
    writeStore(cursorKey, {});

    while (passes < maxPasses) {
      const batch = await readLocalLog();
      passes++;
      const batchRecords = Array.isArray(batch) ? batch : (batch && batch.records) || [];
      records += batchRecords.length;
      bytesRead += Array.isArray(batch) ? 0 : (Number(batch && batch.bytesRead) || 0);
      complete = !Array.isArray(batch) && !!(batch && batch.complete);
      if (onProgress) onProgress({ stage: providerId, detail: 'pass ' + passes + ', +' + batchRecords.length });
      if (complete) break;
    }

    if (!complete) {
      const error = new Error(`Local log rescan incomplete for ${providerId}`);
      error.code = 'LOCAL_LOG_RESCAN_INCOMPLETE';
      error.providerId = providerId;
      error.passes = passes;
      error.bytesRead = bytesRead;
      throw error;
    }
  } catch (error) {
    const current = cloneValue(readStore('usageDaily') || {});
    Object.keys(current).forEach((k) => {
      if (k.indexOf(prefix) === 0) delete current[k];
    });
    Object.keys(backupRows).forEach((k) => {
      current[k] = backupRows[k];
    });
    writeStore('usageDaily', current);
    if (backupCursor !== undefined) {
      writeStore(cursorKey, backupCursor);
    } else if (typeof deleteStore === 'function') {
      deleteStore(cursorKey);
    } else {
      writeStore(cursorKey, undefined);
    }
    throw error;
  }

  const after = readStore('usageDaily') || {};
  const dayRe = new RegExp('^' + providerId + ':(\\d{4}-\\d{2}-\\d{2})$');
  let daysRebuilt = 0;
  let earliestDate = null;
  Object.keys(after).forEach((k) => {
    const m = dayRe.exec(k);
    if (m) {
      daysRebuilt++;
      if (!earliestDate || m[1] < earliestDate) earliestDate = m[1];
    }
  });
  return { daysRebuilt, earliestDate, passes, records, bytesRead };
}

module.exports = { syncDeepSeekHistory, rescanLocalLogs, MAX_MONTHS, EMPTY_STREAK_STOP, MONTH_GAP_MS, MAX_SCAN_PASSES };
