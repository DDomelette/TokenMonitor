// 历史用量同步:DeepSeek 逐月全量回填 + Codex/Kimi 本机日志全量重扫。
// 纯逻辑模块,依赖全部注入,便于 node --test 直测。
const MAX_MONTHS = 36;
// 连续空月停止阈值:12,容忍使用量稀疏的长间隔(曾有 5/6 月空、4 月有数据的真实案例)
const EMPTY_STREAK_STOP = 12;
const MONTH_GAP_MS = 300;
const MAX_SCAN_PASSES = 200;
// 全量同步自己的月份标记:不能用 backfill 的 providers.deepseek.fetchedMonths——
// backfill 抓取时 persistDaily 会按保留窗口丢弃旧日数据,月份却照标"已抓",
// 信任它会让被丢弃的月份永远不再抓(数据永久缺失)。
const SYNCED_MONTHS_KEY = 'providers.deepseek.syncedMonths';

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

// 从当月起逐月向前回填:连续 2 空月停止,硬上限 36 个月;
// 同名 'deepseek:<date>' 键以 API 数据直接覆盖(幂等,API 为准)。
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
  let earliestDate = null;
  Object.keys(usageDaily).forEach((k) => {
    const m = /^deepseek:(\d{4}-\d{2}-\d{2})$/.exec(k);
    if (m && (!earliestDate || m[1] < earliestDate)) earliestDate = m[1];
  });

  let monthsFetched = 0;
  const monthsFailed = [];
  let emptyStreak = 0;

  for (let i = 0; i < MAX_MONTHS && emptyStreak < EMPTY_STREAK_STOP; i++) {
    const key = monthKey(year, month);
    if (!syncedMonths.has(key)) {
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
        );
        if (!days.length) {
          emptyStreak++;
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
          });
        }
        syncedMonths.add(key);
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
  return { monthsFetched, monthsFailed, earliestDate };
}

// 全量重扫本机日志:先删该 provider 的 usageDaily 键并清游标(增量合并会重复累加,
// 必须先行清除,先例见 src/main/providers/kimi/locallog.js 的 MIGRATION_KEY 流程),
// 再循环调用 readLocalLog 直到无新增(scanFiles 单轮有 4MB 预算,全量需多轮)。
async function rescanLocalLogs(options) {
  const providerId = options.providerId;
  const readLocalLog = options.readLocalLog;
  const readStore = options.readStore;
  const writeStore = options.writeStore;
  const onProgress = options.onProgress || null;
  const maxPasses = options.maxPasses || MAX_SCAN_PASSES;

  const prefix = providerId + ':';
  const usageDaily = readStore('usageDaily') || {};
  Object.keys(usageDaily).forEach((k) => {
    if (k.indexOf(prefix) === 0) delete usageDaily[k];
  });
  writeStore('usageDaily', usageDaily);
  writeStore('localLogCursors.' + providerId, {});

  let passes = 0;
  let records = 0;
  while (passes < maxPasses) {
    const batch = await readLocalLog();
    passes++;
    const n = Array.isArray(batch) ? batch.length : 0;
    records += n;
    if (onProgress) onProgress({ stage: providerId, detail: 'pass ' + passes + ', +' + n });
    if (n === 0) break;
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
  return { daysRebuilt, earliestDate, passes, records };
}

module.exports = { syncDeepSeekHistory, rescanLocalLogs, MAX_MONTHS, EMPTY_STREAK_STOP, MONTH_GAP_MS, MAX_SCAN_PASSES };
