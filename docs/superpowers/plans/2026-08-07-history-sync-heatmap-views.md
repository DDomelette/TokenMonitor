# 历史用量同步 + 热力图视图改版 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页新增"同步历史数据"按钮(DeepSeek 逐月回填 + Codex/Kimi 日志全量重扫),并把热力图每周/累计视图改为方块堆积列。

**Architecture:** PR-1 在主进程新增纯逻辑模块 `src/main/core/history-sync.js`(依赖全注入,node --test 直测),经新 IPC 通道 `sync:history`/`sync:progress` 接线到设置页(非 React,声明式 definitions + 自定义 type)。PR-2 重写 `TokenHeatmap.jsx` 的 renderWeekly/renderCumulative 为统一的方块堆积渲染,新纯函数 `blockCount` 进 `renderer/src/lib/heatmap.js`。

**Tech Stack:** Electron 主进程 CJS、node:test + assert/strict(无 jest/vitest)、renderer React(JSX,vite 构建,不参与根测试)、设置页原生 DOM JS。

**Spec:** `docs/superpowers/specs/2026-08-07-history-sync-heatmap-views-design.md`

## Global Constraints

- 测试命令:根目录 `npm test`(= `node --test`,跑整个 `test/`);单文件 `node --test test/<file>`。
- `src/main/**` 与 `test/**` 是 CJS(`require`);`renderer/src/**` 是 ESM,根测试靠 Node ≥22 的 require(esm) 直接 `require('../renderer/src/lib/heatmap.js')`(先例:`test/heatmap-cells.test.js`)。
- UI 文案一律中文,风格与现有设置页/tooltip 一致。
- **不得破坏现有源码级断言**:`test/heatmap-cells.test.js` 断言 TokenHeatmap.jsx 含 `buildWeeks`/`buildSundayWeekTotals`/`sundayWeekKey`/`colorLevel`/`formatToken`/`每日/每周/累计`/`heatmap-tooltip`/`getHeatmap`/`createPortal`/`document.body`;改版必须保留这些符号。
- main 分支受保护:每个 PR 走特性分支,CI 三 job 全绿后 Rebase and merge。
- 最小改动:每日模式渲染、tooltip 机制(portal/定时器/tipLines)、月份行、图例行一律不动,除非任务明确列出。
- DeepSeek 回填:硬上限 36 个月、连续 2 空月即停、单月失败重试 1 次后跳过、月间隔 ~300ms。
- 同名 `'<provider>:<date>'` 键以同步值直接覆盖(幂等);Codex/Kimi 以本机日志为唯一数据源。
- 历史保留天数只提示不擅改(调整按钮由用户主动点击)。

---

## PR 划分与分支

- Task 1–4 → 分支 `feat/history-sync`(PR-1)
- Task 5–6 → 分支 `feat/heatmap-block-views`(PR-2,可从 main 独立开,不依赖 PR-1)

---

### Task 1: history-sync.js — syncDeepSeekHistory

**Files:**
- Create: `src/main/core/history-sync.js`
- Test: `test/history-sync.test.js`

**Interfaces:**
- Produces:
  - `syncDeepSeekHistory({ fetchMonth, readStore, writeStore, onProgress, sleep, now })` → `Promise<{ monthsFetched: number, monthsFailed: string[], earliestDate: string|null }>`
    - `fetchMonth(year, month)` → `Promise<Array<{ date, total, cacheHit, models: [{model, tokens}] }>>`(即 `UsageFetcher.fetchUsageAmount(...)` 的 `.dailyData`)
    - `readStore(key)`/`writeStore(key, value)` 同步存取
    - `onProgress({ stage, detail })` 可选;`sleep(ms)` 可选(测试注入 noop);`now` 可选(注入当前时间)
  - 常量导出:`MAX_MONTHS=36`、`EMPTY_STREAK_STOP=2`、`MONTH_GAP_MS=300`、`MAX_SCAN_PASSES=200`(Task 2 用)

- [ ] **Step 1: 写失败测试**

创建 `test/history-sync.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { syncDeepSeekHistory } = require('../src/main/core/history-sync');

function makeStore(seed) {
  const data = Object.assign({}, seed);
  return { data, get(k) { return data[k]; }, set(k, v) { data[k] = v; } };
}
const noopSleep = async () => {};

test('逐月向前直到连续 2 个空月停止,同名键以 API 覆盖', async () => {
  const store = makeStore({ usageDaily: { 'deepseek:2026-08-01': { input: 0, cached: 0, output: 0, total: 1 } } });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (month === 8) return [{ date: '2026-08-01', total: 100, cacheHit: 40, models: [{ model: 'm1', tokens: 100 }] }];
    if (month === 7) return [{ date: '2026-07-15', total: 50, cacheHit: 0, models: [] }];
    return [];
  };
  const r = await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.deepEqual(calls, ['2026-8', '2026-7', '2026-6', '2026-5']);
  assert.equal(store.data.usageDaily['deepseek:2026-08-01'].total, 100);
  assert.equal(store.data.usageDaily['deepseek:2026-08-01'].cached, 40);
  assert.deepEqual(store.data.usageDaily['deepseek:2026-08-01'].models, [{ model: 'm1', tokens: 100 }]);
  assert.equal(store.data.usageDaily['deepseek:2026-07-15'].total, 50);
  assert.equal(r.monthsFetched, 4);
  assert.deepEqual(r.monthsFailed, []);
  assert.equal(r.earliestDate, '2026-07-15');
  assert.deepEqual(store.data['providers.deepseek.fetchedMonths'], ['2026-08', '2026-07', '2026-06', '2026-05']);
});

test('单月失败重试一次后跳过并计入 failed,流程不中断', async () => {
  const store = makeStore({});
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (month === 7) throw new Error('network');
    if (month === 8) return [{ date: '2026-08-01', total: 10, cacheHit: 0, models: [] }];
    return [];
  };
  const r = await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.deepEqual(calls, ['2026-8', '2026-7', '2026-7', '2026-6', '2026-5']);
  assert.deepEqual(r.monthsFailed, ['2026-07']);
  assert.equal(r.monthsFetched, 3);
  assert.ok(!store.data['providers.deepseek.fetchedMonths'].includes('2026-07'));
});

test('最多向前探测 36 个月', async () => {
  const store = makeStore({});
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    return [{ date: year + '-' + String(month).padStart(2, '0') + '-15', total: 1, cacheHit: 0, models: [] }];
  };
  await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.equal(calls.length, 36);
  assert.equal(calls[35], '2023-9');
});

test('已在 fetchedMonths 中的月份直接跳过不重复请求', async () => {
  const store = makeStore({ 'providers.deepseek.fetchedMonths': ['2026-08', '2026-07'] });
  const calls = [];
  const fetchMonth = async (year, month) => {
    calls.push(year + '-' + month);
    if (month === 6) return [{ date: '2026-06-17', total: 5, cacheHit: 0, models: [] }];
    return [];
  };
  const r = await syncDeepSeekHistory({
    fetchMonth, readStore: store.get, writeStore: store.set,
    now: '2026-08-07T12:00:00', sleep: noopSleep
  });
  assert.deepEqual(calls, ['2026-6', '2026-5', '2026-4']);
  assert.equal(r.earliestDate, '2026-06-17');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/history-sync.test.js`
Expected: FAIL,`Cannot find module '../src/main/core/history-sync'`

- [ ] **Step 3: 实现 history-sync.js**

创建 `src/main/core/history-sync.js`:

```js
// 历史用量同步:DeepSeek 逐月全量回填 + Codex/Kimi 本机日志全量重扫。
// 纯逻辑模块,依赖全部注入,便于 node --test 直测。
const MAX_MONTHS = 36;
const EMPTY_STREAK_STOP = 2;
const MONTH_GAP_MS = 300;
const MAX_SCAN_PASSES = 200;

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
  const fetchedMonths = new Set(readStore('providers.deepseek.fetchedMonths') || []);
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
    if (!fetchedMonths.has(key)) {
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
        fetchedMonths.add(key);
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
  writeStore('providers.deepseek.fetchedMonths', Array.from(fetchedMonths));
  return { monthsFetched, monthsFailed, earliestDate };
}

module.exports = { syncDeepSeekHistory, MAX_MONTHS, EMPTY_STREAK_STOP, MONTH_GAP_MS, MAX_SCAN_PASSES };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/history-sync.test.js`
Expected: PASS(4 个测试)

- [ ] **Step 5: Commit**

```bash
git add src/main/core/history-sync.js test/history-sync.test.js
git commit -m "feat: 历史同步核心——DeepSeek 逐月回填(36 月上限/空月连停/失败跳过)"
```

---

### Task 2: history-sync.js — rescanLocalLogs

**Files:**
- Modify: `src/main/core/history-sync.js`
- Test: `test/history-sync.test.js`

**Interfaces:**
- Consumes: Task 1 的模块与常量 `MAX_SCAN_PASSES`
- Produces:
  - `rescanLocalLogs({ providerId, readLocalLog, readStore, writeStore, onProgress, maxPasses })` → `Promise<{ daysRebuilt: number, earliestDate: string|null, passes: number, records: number }>`
    - `readLocalLog()` → `Promise<Array>`:闭包,内部即 `provider.readLocalLog({ store })`;每轮最多扫 4MB(预算限制),返回新增 records,无新增返回 `[]`
  - 行为:先删 `usageDaily` 中 `<providerId>:` 前缀键、清 `localLogCursors.<providerId>` 游标,再循环 `readLocalLog()` 直到返回空(或达 `maxPasses`),最后统计重建天数与最早日期

- [ ] **Step 1: 追加失败测试**

在 `test/history-sync.test.js` 顶部 import 处追加 `rescanLocalLogs`,文件尾部追加:

```js
test('重扫:清该 provider 前缀键与游标,循环扫描直到无新增,覆盖同名键', async () => {
  const store = makeStore({
    usageDaily: {
      'codex:2026-06-17': { input: 0, cached: 0, output: 0, total: 999 },
      'kimi:2026-06-17': { input: 0, cached: 0, output: 0, total: 5 }
    },
    'localLogCursors.codex': { '/x/rollout-a.jsonl': { offset: 123, mtimeMs: 1 } }
  });
  let pass = 0;
  const readLocalLog = async () => {
    pass++;
    if (pass === 1) {
      store.data.usageDaily['codex:2026-06-17'] = { input: 10, cached: 0, output: 40, total: 50 };
      store.data.usageDaily['codex:2026-06-18'] = { input: 1, cached: 0, output: 1, total: 2 };
      return [{}, {}];
    }
    return [];
  };
  const r = await rescanLocalLogs({
    providerId: 'codex', readLocalLog, readStore: store.get, writeStore: store.set
  });
  assert.equal(store.data.usageDaily['codex:2026-06-17'].total, 50);
  assert.equal(store.data.usageDaily['kimi:2026-06-17'].total, 5);
  assert.deepEqual(store.data['localLogCursors.codex'], {});
  assert.equal(r.daysRebuilt, 2);
  assert.equal(r.earliestDate, '2026-06-17');
  assert.equal(r.passes, 2);
  assert.equal(r.records, 2);
});

test('重扫:日志为空时 daysRebuilt=0,不视为错误', async () => {
  const store = makeStore({});
  const readLocalLog = async () => [];
  const r = await rescanLocalLogs({
    providerId: 'kimi', readLocalLog, readStore: store.get, writeStore: store.set
  });
  assert.equal(r.daysRebuilt, 0);
  assert.equal(r.earliestDate, null);
  assert.equal(r.passes, 1);
});

test('日边界:rollupDaily 聚合键为本地(北京)日历日', () => {
  const { rollupDaily } = require('../src/main/core/locallog');
  const ts = Date.UTC(2026, 5, 17, 16, 30); // UTC 16:30,北京时间为次日 00:30
  ['codex', 'kimi'].forEach((pid) => {
    const daily = rollupDaily([{ provider: pid, ts, usage: { input: 1, cached: 0, output: 1, total: 2 } }]);
    const d = new Date(ts);
    const key = pid + ':' + d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    assert.ok(daily[key], pid + ' 应按本地日历日聚合,实际键:' + Object.keys(daily).join(','));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/history-sync.test.js`
Expected: FAIL,`rescanLocalLogs is not a function`(解构得到 undefined)

- [ ] **Step 3: 实现 rescanLocalLogs**

在 `src/main/core/history-sync.js` 的 `module.exports` 之前追加:

```js
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
```

并把 `module.exports` 改为:

```js
module.exports = { syncDeepSeekHistory, rescanLocalLogs, MAX_MONTHS, EMPTY_STREAK_STOP, MONTH_GAP_MS, MAX_SCAN_PASSES };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/history-sync.test.js`
Expected: PASS(7 个测试)

- [ ] **Step 5: Commit**

```bash
git add src/main/core/history-sync.js test/history-sync.test.js
git commit -m "feat: 历史同步核心——Codex/Kimi 本机日志全量重扫(清键清游标+多轮扫描)"
```

---

### Task 3: IPC 接线 sync:history + preload 白名单

**Files:**
- Modify: `src/main/ipc.js`(顶部 require 区 + 在 `get:heatmap` handler 附近新增 handler)
- Modify: `src/preload/preload.js`(两个白名单各加一项)
- Test: `test/history-sync-ipc.test.js`(新建,源码级断言,惯例见 `test/usage-retention-ipc.test.js`)

**Interfaces:**
- Consumes: Task 1/2 的 `syncDeepSeekHistory`/`rescanLocalLogs`;`UsageFetcher.fetchUsageAmount(token, month, year, { httpGet, proxyUrl })` → `{ dailyData }`;`deps.registry.get(pid).readLocalLog({ store })`;`deps.scheduler.pollAll()`;`retentionStartDay(historyDays)`(来自 `src/main/core/usage-retention.js`)
- Produces:
  - IPC invoke 通道 `sync:history` → `Promise<{ deepseek: {...}|{skipped:true,reason:'not-logged-in'}, codex: {...}, kimi: {...}, retentionHint?: { historyDays, earliestDate, suggestedDays } }>`
  - IPC 事件通道 `sync:progress`,负载 `{ stage: 'deepseek'|'codex'|'kimi', detail: string }`

- [ ] **Step 1: 写失败测试(源码级断言)**

创建 `test/history-sync-ipc.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ipcSource = fs.readFileSync(path.resolve(__dirname, '../src/main/ipc.js'), 'utf8');
const preloadSource = fs.readFileSync(path.resolve(__dirname, '../src/preload/preload.js'), 'utf8');

test('sync:history handler 编排三路同步并刷新仪表盘', () => {
  assert.match(ipcSource, /ipcMain\.handle\('sync:history'/);
  assert.match(ipcSource, /require\('\.\/core\/history-sync'\)/);
  assert.match(ipcSource, /syncDeepSeekHistory\(/);
  assert.match(ipcSource, /rescanLocalLogs\(/);
  assert.match(ipcSource, /providers\.deepseek\.sessionToken/);
  assert.match(ipcSource, /sync:progress/);
  assert.match(ipcSource, /retentionHint/);
  assert.match(ipcSource, /pollAll\(\)/);
});

test('preload 白名单放行 sync:history 与 sync:progress', () => {
  assert.match(preloadSource, /'sync:history'/);
  assert.match(preloadSource, /'sync:progress'/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/history-sync-ipc.test.js`
Expected: FAIL(全部断言不命中)

- [ ] **Step 3: 实现接线**

`src/main/ipc.js` 顶部 require 区追加:

```js
const { syncDeepSeekHistory, rescanLocalLogs } = require('./core/history-sync');
const { UsageFetcher } = require('./providers/deepseek/usage');
const { httpGet } = require('./core/http');
const { SYSTEM_PROXY_VALUE, resolveElectronSystemProxy } = require('./core/proxy-settings');
```

注意:`filterUsageDaily` 已从 `./core/usage-retention` require,把该 require 改为同时带出 `retentionStartDay`:

```js
const { filterUsageDaily, retentionStartDay } = require('./core/usage-retention');
```

在 `get:heatmap` handler 之后新增(沿用现有 handler 风格):

```js
  ipcMain.handle('sync:history', async (event) => {
    const sendProgress = (p) => {
      try {
        event.sender.send('sync:progress', p);
      } catch (e) { /* 设置窗口已关闭,进度丢弃 */ }
    };
    const readStore = (k) => deps.store.get(k);
    const writeStore = (k, v) => deps.store.set(k, v);
    const summary = {};

    const token = deps.store.get('providers.deepseek.sessionToken');
    if (token) {
      const storedProxy = deps.store.get('providers.proxyUrl') || null;
      const proxyUrl = storedProxy === SYSTEM_PROXY_VALUE ? resolveElectronSystemProxy : storedProxy;
      const fetcher = new UsageFetcher();
      summary.deepseek = await syncDeepSeekHistory({
        fetchMonth: (year, month) =>
          fetcher.fetchUsageAmount(token, month, year, { httpGet, proxyUrl }).then((r) => r.dailyData),
        readStore,
        writeStore,
        onProgress: sendProgress
      });
    } else {
      summary.deepseek = { skipped: true, reason: 'not-logged-in' };
    }

    for (const pid of ['codex', 'kimi']) {
      const provider = deps.registry.get(pid);
      if (!provider || typeof provider.readLocalLog !== 'function') {
        summary[pid] = { daysRebuilt: 0, earliestDate: null, skipped: true };
        continue;
      }
      summary[pid] = await rescanLocalLogs({
        providerId: pid,
        readLocalLog: () => provider.readLocalLog({ store: deps.store }),
        readStore,
        writeStore,
        onProgress: sendProgress
      });
    }

    // 历史保留提示:最早日期落在保留窗口外时给出建议天数(只提示不擅改)
    const historyDays = deps.store.get('data.historyDays');
    const earliest = [summary.deepseek, summary.codex, summary.kimi]
      .map((r) => r && r.earliestDate)
      .filter(Boolean)
      .sort()[0] || null;
    if (earliest && Number.isInteger(historyDays) && historyDays > 0 && earliest < retentionStartDay(historyDays)) {
      const startMs = new Date(earliest + 'T12:00:00').getTime();
      summary.retentionHint = {
        historyDays,
        earliestDate: earliest,
        suggestedDays: Math.ceil((Date.now() - startMs) / 86400000) + 1
      };
    }

    // 广播 providers:changed,渲染端 TokenHeatmap/ProviderBar 已订阅,会自动重取 get:heatmap
    if (deps.scheduler && typeof deps.scheduler.pollAll === 'function') {
      await deps.scheduler.pollAll();
    }
    return summary;
  });
```

`src/preload/preload.js`:`on` 的 validChannels 数组追加 `'sync:progress'`,`invoke` 的 validChannels 数组追加 `'sync:history'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/history-sync-ipc.test.js`
Expected: PASS(2 个测试)

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.js src/preload/preload.js test/history-sync-ipc.test.js
git commit -m "feat: sync:history IPC 接线——编排三路同步+进度推送+保留天数提示"
```

---

### Task 4: 设置页"历史数据"区块

**Files:**
- Modify: `src/renderer/js/settings-definitions.js`
- Modify: `src/renderer/js/settings-window.js`
- Test: `test/settings-history-sync.test.js`(新建,源码级断言)

**Interfaces:**
- Consumes: Task 3 的 `sync:history`(invoke)/`sync:progress`(on)通道与 summary 形状
- Produces(供断言的 DOM id / 文案):`historySyncBtn`、`historySyncProgress`、`historySyncResult`、`historySyncRetentionBtn`;区块组名 `历史数据`

- [ ] **Step 1: 写失败测试(源码级断言)**

创建 `test/settings-history-sync.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const defsSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer/js/settings-definitions.js'), 'utf8');
const jsSource = fs.readFileSync(path.resolve(__dirname, '../src/renderer/js/settings-window.js'), 'utf8');

test('设置页声明历史数据区块并渲染同步控件', () => {
  assert.match(defsSource, /group:\s*'历史数据'/);
  assert.match(defsSource, /type:\s*'historySync'/);
  assert.match(jsSource, /historySyncBtn/);
  assert.match(jsSource, /historySyncProgress/);
  assert.match(jsSource, /historySyncResult/);
  assert.match(jsSource, /同步历史数据/);
});

test('设置页调用 sync:history 并监听 sync:progress,展示保留天数提示', () => {
  assert.match(jsSource, /invoke\('sync:history'\)/);
  assert.match(jsSource, /on\('sync:progress'/);
  assert.match(jsSource, /retentionHint/);
  assert.match(jsSource, /data\.historyDays/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/settings-history-sync.test.js`
Expected: FAIL

- [ ] **Step 3: 实现设置页改动**

`src/renderer/js/settings-definitions.js`:在 `networkDefinitions` 之后新增数组并拼入(位置决定区块顺序,紧挨"网络"区块下方):

```js
var historyDefinitions = [
  { group: '历史数据', key: 'history.sync', type: 'historySync', label: '用量历史同步', default: '' }
];
```

`window.SettingsDefinitions` 改为:

```js
window.SettingsDefinitions = windowDefinitions.concat(
  networkDefinitions,
  historyDefinitions,
  componentDefinitions,
  tailDefinitions
);
```

`src/renderer/js/settings-window.js` 三处改动:

① `render()` 的 switch 中(`case 'proxy'` 之前或之后均可)新增:

```js
      case 'historySync':
        return '<div style="display:flex;flex-direction:column;gap:6px;width:100%;">' +
          '<button type="button" class="btn btn-primary" id="historySyncBtn">同步历史数据</button>' +
          '<span id="historySyncProgress" role="status" hidden style="font-size:12px;line-height:1.3;"></span>' +
          '<span id="historySyncResult" role="status" hidden style="font-size:12px;line-height:1.5;white-space:pre-line;"></span>' +
          '<button type="button" class="btn" id="historySyncRetentionBtn" hidden></button>' +
        '</div>';
```

② `buildPanel` 中 vertical 判断(settings-window.js:257)改为:

```js
          var vertical = d.type === 'slider' || d.type === 'credential' || d.type === 'proxy' || d.type === 'historySync';
```

③ 新增一组函数(放在 `submitProxySetting` 之后),并在 `bindEvents()` 末尾绑定按钮:

```js
  function showHistorySyncProgress(message) {
    var el = document.getElementById('historySyncProgress');
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  function setHistorySyncPending(pending) {
    var btn = document.getElementById('historySyncBtn');
    if (btn) {
      btn.disabled = pending;
      btn.textContent = pending ? '同步中…' : '同步历史数据';
    }
  }

  function formatHistorySyncSummary(summary) {
    var lines = [];
    if (summary.deepseek && summary.deepseek.skipped) {
      lines.push('DeepSeek:未登录平台,仅同步了本机数据');
    } else if (summary.deepseek) {
      var ds = summary.deepseek;
      lines.push('DeepSeek:同步 ' + ds.monthsFetched + ' 个月' +
        (ds.monthsFailed && ds.monthsFailed.length ? ',' + ds.monthsFailed.length + ' 个月失败(' + ds.monthsFailed.join('、') + ')' : '') +
        (ds.earliestDate ? ',最早 ' + ds.earliestDate : ''));
    }
    ['codex', 'kimi'].forEach(function (pid) {
      var r = summary[pid];
      if (!r) return;
      var label = pid === 'codex' ? 'Codex' : 'Kimi';
      lines.push(label + ':重建 ' + r.daysRebuilt + ' 天' + (r.earliestDate ? ',最早 ' + r.earliestDate : ''));
    });
    return lines.join('\n');
  }

  function showHistorySyncResult(summary) {
    var el = document.getElementById('historySyncResult');
    var hint = summary.retentionHint || null;
    if (el) {
      var text = formatHistorySyncSummary(summary);
      if (hint) {
        text += '\n当前历史保留 ' + hint.historyDays + ' 天,早于 ' + hint.earliestDate +
          ' 的数据会被自动清理,建议调到 ≥ ' + hint.suggestedDays + ' 天';
      }
      el.textContent = text;
      el.hidden = !text;
    }
    var btn = document.getElementById('historySyncRetentionBtn');
    if (btn) {
      if (hint) {
        btn.hidden = false;
        btn.textContent = '调整为 ' + hint.suggestedDays + ' 天';
        btn.onclick = function () {
          window.api.invoke('settings:save', { key: 'data.historyDays', value: hint.suggestedDays }).then(function () {
            btn.hidden = true;
            showHistorySyncProgress('历史保留天数已调整为 ' + hint.suggestedDays + ' 天,可再次同步补齐被清理的数据。');
          });
        };
      } else {
        btn.hidden = true;
      }
    }
  }

  function submitHistorySync() {
    setHistorySyncPending(true);
    showHistorySyncProgress('正在同步…');
    window.api.invoke('sync:history').then(function (summary) {
      showHistorySyncResult(summary || {});
      showHistorySyncProgress('');
    }).catch(function () {
      showHistorySyncProgress('同步失败,请稍后重试。');
    }).then(function () {
      setHistorySyncPending(false);
    });
  }
```

`bindEvents()` 末尾(`proxySaveBtn` 绑定之后)追加:

```js
    var historySyncBtn = document.getElementById('historySyncBtn');
    if (historySyncBtn) {
      historySyncBtn.addEventListener('click', submitHistorySync);
    }
```

文件底部(`window.api.on('session:changed', ...)` 附近)追加进度监听:

```js
  window.api.on('sync:progress', function (p) {
    if (!p) return;
    var stageLabel = { deepseek: 'DeepSeek', codex: 'Codex', kimi: 'Kimi' }[p.stage] || p.stage;
    showHistorySyncProgress('正在同步 ' + stageLabel + ' ' + (p.detail || '') + ' …');
  });
```

注意:`settings:save` 写 `data.historyDays` 走现有白名单,主进程保存后会自动重算清理(`core/settings-write.js`),调大天数不会误删数据。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/settings-history-sync.test.js`
Expected: PASS(2 个测试)

- [ ] **Step 5: 全套回归 + Commit + PR**

Run: `npm test`
Expected: 全部通过(基线 ~399 过 0 失败 6 skip,新增后数量增加)

```bash
git add src/renderer/js/settings-definitions.js src/renderer/js/settings-window.js test/settings-history-sync.test.js
git commit -m "feat: 设置页历史数据区块——同步按钮+进度+结果汇总+保留天数一键调整"
git push -u origin feat/history-sync
gh pr create --title "feat: 历史用量同步——DeepSeek 逐月回填 + Codex/Kimi 日志全量重扫" --body "按 docs/superpowers/specs/2026-08-07-history-sync-heatmap-views-design.md 的 PR-1"
```

---

### Task 5: heatmap.js — blockCount 纯函数

**Files:**
- Modify: `renderer/src/lib/heatmap.js`
- Test: `test/heatmap-block-count.test.js`(新建)

**Interfaces:**
- Produces:
  - `blockCount(value, scale)` → `number`(0..10):`value<=0` 或 `scale<=0` 返回 0;否则 `Math.max(1, Math.min(10, Math.round(value / scale)))`
  - 常量 `MAX_HEATMAP_BLOCKS = 10`(具名导出,组件与测试共用)

- [ ] **Step 1: 写失败测试**

创建 `test/heatmap-block-count.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { blockCount, MAX_HEATMAP_BLOCKS } = require('../renderer/src/lib/heatmap.js');

test('blockCount: 零值与非法 scale 返回 0', () => {
  assert.equal(blockCount(0, 10), 0);
  assert.equal(blockCount(5, 0), 0);
  assert.equal(blockCount(-3, 10), 0);
});

test('blockCount: value>0 至少 1 块,按比例取整,封顶 MAX_HEATMAP_BLOCKS', () => {
  assert.equal(MAX_HEATMAP_BLOCKS, 10);
  assert.equal(blockCount(1, 10), 1);
  assert.equal(blockCount(50, 10), 5);
  assert.equal(blockCount(100, 10), 10);
  assert.equal(blockCount(999, 10), 10);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/heatmap-block-count.test.js`
Expected: FAIL,`blockCount is not a function`(require(esm) 解构得到 undefined)

- [ ] **Step 3: 实现**

`renderer/src/lib/heatmap.js` 末尾(现有 `formatToken` 之后)追加,并确认 `export` 一并导出:

```js
// 方块堆积列(每周/累计模式):列内方块数 ∝ 值,scale = 列最大值 / MAX_HEATMAP_BLOCKS
const MAX_HEATMAP_BLOCKS = 10;

function blockCount(value, scale) {
  const v = Number(value) || 0;
  const s = Number(scale) || 0;
  if (v <= 0 || s <= 0) return 0;
  return Math.max(1, Math.min(MAX_HEATMAP_BLOCKS, Math.round(v / s)));
}

export { MAX_HEATMAP_BLOCKS, blockCount };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/heatmap-block-count.test.js`
Expected: PASS(2 个测试)

- [ ] **Step 5: Commit**

```bash
git add renderer/src/lib/heatmap.js test/heatmap-block-count.test.js
git commit -m "feat: 热力图方块堆积——blockCount 纯函数(MAX 10 块自适应)"
```

---

### Task 6: TokenHeatmap 每周/累计方块堆积重写

**Files:**
- Modify: `renderer/src/components/TokenHeatmap.jsx`(renderWeekly/renderCumulative/showTip/colWidth/文件头注释)
- Modify: `renderer/src/styles.css`(热力图区,约 594–606 行)
- Test: `test/heatmap-cells.test.js`(追加断言,不断言旧符号消失以免脆弱)

**Interfaces:**
- Consumes: Task 5 的 `blockCount`/`MAX_HEATMAP_BLOCKS`;现有 `buildSundayWeekTotals`/`sundayWeekKey`/`dateLabel`/`formatToken`/`lastInYearDate`/`tipTotal`/`showTip`/`moveTip`/`hideTip`
- Produces: 每周/累计模式渲染改用 `.heatmap-grid-blocks` + `.heatmap-block-col`;`showTip(e, date, overrideLines, headText)` 第 4 参;head 文案 `X月X日 当周使用了` / `截至 X年X月X日 当周累计使用`

- [ ] **Step 1: 追加失败断言**

`test/heatmap-cells.test.js` 文件尾部追加:

```js
test('TokenHeatmap renders weekly/cumulative as stacked block columns', () => {
  assert.match(heatmapJsx, /blockCount/);
  assert.match(heatmapJsx, /heatmap-grid-blocks/);
  assert.match(heatmapJsx, /heatmap-block-col/);
  assert.match(heatmapJsx, /当周使用了/);
  assert.match(heatmapJsx, /当周累计使用/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/heatmap-cells.test.js`
Expected: 新测试 FAIL,其余 PASS

- [ ] **Step 3: 重写 TokenHeatmap.jsx**

① 文件头注释(第 1 行)改为:

```jsx
// GitHub 风格 Token 活动热力图:每日(53×7)/每周·累计(方块堆积列)三模式。
```

② import 行(第 6 行)加入 `blockCount`:

```jsx
import { buildSundayWeekTotals, buildWeeks, blockCount, colorLevel, formatToken, sundayWeekKey } from '../lib/heatmap.js';
```

③ 常量区(第 14–16 行后)追加:

```jsx
const MAX_COL_BLOCKS = 10; // 与 lib/heatmap.js 的 MAX_HEATMAP_BLOCKS 对应
const BLOCK_W = CELL + 6;
const BLOCK_H = CELL;
const COL_HEIGHT = MAX_COL_BLOCKS * BLOCK_H + (MAX_COL_BLOCKS - 1) * GAP;
```

④ 第 77 行 colWidth 改为(每周/累计同为宽列):

```jsx
  const colWidth = mode === 'daily' ? CELL + GAP : CELL + GAP + 6;
```

⑤ `showTip` 签名加第 4 参(第 143 行),`pendingTip.current` 赋值(第 149–155 行)加 `headText`:

```jsx
  const showTip = (e, date, overrideLines, headText) => {
    if (!date) return;
    ['settle', 'hide', 'fade'].forEach(clearTimer);
    lastTipX.current = e.clientX;
    const r = e.currentTarget.getBoundingClientRect();
    const below = r.top < 140;
    pendingTip.current = {
      x: clampTipX(r.left + r.width / 2),
      y: below ? r.bottom + 6 : r.top - 6,
      below: below,
      date: date,
      overrideLines: overrideLines || null,
      headText: headText || null
    };
```

(函数其余部分不动。)

⑥ `renderWeekly`(251–278 行)与 `renderCumulative`(280–300 行)**整体替换**为:

```jsx
  // 方块堆积列:每周/累计共用。列高固定(MAX_COL_BLOCKS),方块从底向上堆,空周整列可悬停
  const blockScale = mode === 'weekly'
    ? (maxWeek > 0 ? maxWeek / MAX_COL_BLOCKS : 0)
    : (maxCum > 0 ? maxCum / MAX_COL_BLOCKS : 0);

  function renderBlockColumns(valueForCol, headTextForCol) {
    return (
      <div className="heatmap-grid heatmap-grid-blocks">
        {visibleWeeks.map((col, i) => {
          const c = start + i;
          const date = lastInYearDate(c);
          const blocks = blockCount(valueForCol(c, col), blockScale);
          return (
            <div
              key={c}
              className="heatmap-block-col"
              style={{ height: COL_HEIGHT }}
              onMouseEnter={(e) => showTip(e, date, null, headTextForCol(c, col))}
              onMouseMove={moveTip} onMouseLeave={hideTip}
            >
              {Array.from({ length: blocks }).map((_, b) => (
                <div
                  key={b}
                  className="heatmap-cell"
                  style={{ width: BLOCK_W, height: BLOCK_H, background: 'rgba(116,184,252,0.55)' }}
                />
              ))}
            </div>
          );
        })}
      </div>
    );
  }

  function renderWeekly() {
    return renderBlockColumns(
      (c, col) => {
        const weekKey = col[0] ? sundayWeekKey(new Date(col[0].date + 'T00:00:00')) : null;
        return weekKey ? weekTotals[weekKey] || 0 : 0;
      },
      (c, col) => {
        const weekKey = col[0] ? sundayWeekKey(new Date(col[0].date + 'T00:00:00')) : null;
        return weekKey ? dateLabel(weekKey) + ' 当周使用了' : null;
      }
    );
  }

  function renderCumulative() {
    return renderBlockColumns(
      (c) => {
        const date = lastInYearDate(c);
        return date && cumByDate[date] ? cumByDate[date] : 0;
      },
      (c) => {
        const date = lastInYearDate(c);
        return date ? '截至 ' + date.slice(0, 4) + '年' + dateLabel(date) + ' 当周累计使用' : null;
      }
    );
  }
```

⑦ tooltip 头部(第 368 行)支持 headText 覆盖:

```jsx
                <span className="heatmap-tooltip-date">{tip.headText || dateLabel(tip.date)}</span>
```

说明:tooltip 总量由现有 `tipTotal(date)` 按 mode 取周合计/累计,无需改;平台明细行 `tipLines` 逻辑不变;portal 机制不动。月份行第 308 行 `mode === 'daily' ? GAP : GAP + 6` 与新列宽一致,不动。

- [ ] **Step 4: 更新 styles.css**

删除(约 594–606 行):

```css
.heatmap-grid-weekly {
  width: max-content;
}

.heatmap-grid-cumulative {
  align-items: flex-end;
  height: 62px;
}
.heatmap-cum-bar {
  width: 14px;
  border-radius: 2px 2px 0 0;
}
```

替换为:

```css
/* 每周/累计模式:方块堆积列 */
.heatmap-grid-blocks {
  width: max-content;
  align-items: flex-end;
}
.heatmap-block-col {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 2px;
}
```

每日模式的 `.heatmap-grid-daily .heatmap-col`(584–588 行)不动。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/heatmap-cells.test.js test/heatmap-block-count.test.js`
Expected: 全部 PASS(含旧断言:buildSundayWeekTotals/sundayWeekKey/colorLevel/formatToken/每日/每周/累计/heatmap-tooltip/createPortal/document.body 均保留)

- [ ] **Step 6: 渲染构建自检 + 全套回归 + Commit + PR**

Run: `npm --prefix renderer run build`
Expected: vite 构建成功(JSX 语法无误)

Run: `npm test`
Expected: 全部通过

```bash
git add renderer/src/components/TokenHeatmap.jsx renderer/src/styles.css renderer/src/lib/heatmap.js test/heatmap-cells.test.js
git commit -m "feat: 热力图每周/累计改为方块堆积列,tooltip 补当周/累计文案"
git push -u origin feat/heatmap-block-views
gh pr create --title "feat: 热力图每周/累计视图改版——方块堆积列" --body "按 docs/superpowers/specs/2026-08-07-history-sync-heatmap-views-design.md 的 PR-2"
```

---

## 验收(两个 PR 合并后,实机)

1. 设置页 → 历史数据 → 同步历史数据:进度文本滚动,结束后汇总三平台结果;未登录 DeepSeek 时如实注明。
2. 主窗口热力图:DeepSeek 6 月及更早出现数据(若账号当时有用量);Codex 6/17 起的日子补齐(日志覆盖范围内)。
3. 若最早日期超出保留窗口:汇总下方出现提示与"调整为 N 天"按钮,点击后再同步一次,旧数据保留。
4. 每周模式:方块从底向上堆积,高度 ∝ 当周量;悬停显示 "X月X日 当周使用了 N Token"。
5. 累计模式:列高单调不减;悬停显示 "截至 X 年 X 月 X 日 当周累计使用 N Token"。
6. tooltip 不被卡片裁剪、不触发模块自动撑高(PR #165 的 portal 机制未被破坏)。
