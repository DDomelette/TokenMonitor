# DSH Usage 被动接收（ingest）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 TokenMonitor 主进程实现 `POST /api/v1/dsh/usage` 被动接收服务：校验/去重 dsh exporter 推送的 batch，复用现有遥测行映射，把 push 数据写入独立的 `usageDailyPush` / `usageDailyCostPush`，并在 dashboard / heatmap / token-speed / MCP 读取时与本地文件聚合合并。

**Architecture:** 新增 `src/main/providers/dsh/ingest/` 子模块（token、config、validate、registry、apply、server、runtime），提炼 `src/main/providers/dsh/usage-records.js` 让文件扫描与 ingest 共用行映射/rollup；新增 `src/main/core/dsh-usage-merge.js` 作为本地 + push 聚合的合并纯函数层。scheduler 通过 `provider.shouldPollLocalLog(ctx)` 询问 dsh 是否应跳过 localLog 轮询，ingest 提交与 localLog/手动重扫共享 `scheduler.runExclusive('dsh','localLog')` 串行队列。

**Tech Stack:** Electron 主进程 CommonJS + `node:http` / `node:crypto`（不新增依赖）；renderer 设置页沿用现有 ES5 `settings-window.js` 模式；测试 `node --test`。

**Spec:** `docs/superpowers/specs/2026-08-16-dsh-usage-ingest-handoff.md`（执行前必须完整读一遍；本计划中的默认值、字段约束、响应 shape 均以 spec 为准）。

## Global Constraints

- 工作目录：`/mnt/d/Deepseek_Monitor/.worktrees/dsh-usage-ingest-impl`（branch `feat/dsh-usage-ingest-impl`）。
- 不新增 npm 依赖；所有 HTTP 能力用 `node:http`，哈希/随机 token 用 `node:crypto`。
- 主进程代码 CommonJS；renderer 设置页保持现有 `var`/IIFE 风格。
- 默认值（与 spec 逐字一致）：ingest 基础端口 `29351`，回退窗口 `29351–29360`，监听 `127.0.0.1`；`ingest.dsh.enabled` 默认 `true`；`ingest.dsh.batchTtlDays=7`；`ingest.dsh.pushLeaseMs=600000`（最小 `180000`）；`ingest.dsh.rateLimitPerSourcePerMinute=30`；`providers.dsh.collectionMode='auto'`（`auto|localLog|push`）；token 为 48 位 hex（与 MCP token 一致）。
- 幂等键 `(sourceId, batchId)`；注册表上限 200,000；只淘汰过期项，淘汰后仍超限返回 `503 registry-full`。
- 校验整批 all-or-nothing；重复 batch 返回 `{ok:true,accepted:0,duplicates:<rowCount>}`；同键不同 `bodyHash` 返回 `409 batch-conflict`。
- heartbeat 请求：`{sourceId,rootId,sentAt,heartbeat:true}`，不携带 `batchId`/非空 `rows`，不写账本与注册表，只更新 `ingest.dsh.sources`。
- 每个 Task 结束跑 `npm test`（根目录），必须全绿；每个 Task 单独 commit，message 见任务。
- Windows 路径 rootId 规范化：`path.resolve` 后 `\`→`/`，整串 `toLowerCase()`；非 Windows 保持原串。

## File Structure

| 文件 | 职责 | 状态 |
| --- | --- | --- |
| `src/main/providers/dsh/usage-records.js` | 行对象→UsageRecord 映射、JSONL 行解析、dsh rollup（文件/ingest 共用） | 新建 |
| `src/main/providers/dsh/telemetrylog.js` | localLog 文件扫描；改用 `usage-records` 的解析与 rollup | 修改 |
| `src/main/core/dsh-usage-merge.js` | push 存储键常量、dsh 键合并、有效 usageDaily/usageDailyCost 读取 | 新建 |
| `src/main/providers/dsh/push-store.js` | 把 ingest records 原子提交到 `usageDailyPush`/`usageDailyCostPush` | 新建 |
| `src/main/providers/dsh/ingest/validate.js` | envelope/rows 校验、`IngestError`、`computeBodyHash` | 新建 |
| `src/main/providers/dsh/ingest/registry.js` | 持久化幂等注册表：TTL 剪枝、重复/冲突/容量分类 | 新建 |
| `src/main/providers/dsh/ingest/apply.js` | batch/heartbeat 业务入口：校验→串行提交→source 活跃状态 | 新建 |
| `src/main/providers/dsh/ingest/token.js` | ingest token 生成/ensure/rotate | 新建 |
| `src/main/providers/dsh/ingest/config.js` | `ingest.dsh.*` 配置读取与归一化 | 新建 |
| `src/main/providers/dsh/ingest/server.js` | 纯 node http 服务器：Host 白名单、Bearer、1 MiB、限流 | 新建 |
| `src/main/providers/dsh/ingest/index.js` | `startIngest()` 运行时装配（config/token/apply/server） | 新建 |
| `src/main/core/dsh-collection-mode.js` | collectionMode 归一化、rootId 派生、source 活跃判定、是否轮询 localLog | 新建 |
| `src/main/providers/dsh/index.js` | 暴露 `shouldPollLocalLog(ctx)` | 修改 |
| `src/main/core/scheduler.js` | `pollLocalLog` 开始时询问 provider 是否轮询 | 修改 |
| `src/main/core/dsh-dashboard.js` | `buildDshDashboard` 接受 push 聚合并合并 | 修改 |
| `src/main/ipc.js` | dashboard/heatmap 用有效聚合；新增 `ingest:getConnectionInfo` / `ingest:rotateToken` | 修改 |
| `src/main/core/token-speed-runtime.js` | dsh 观察值合并 push 聚合 | 修改 |
| `src/main/mcp/index.js` | MCP usageDaily 数据源改为有效聚合 | 修改 |
| `src/main/core/usage-retention.js` | 新增 `pruneDshPushUsage(store)` | 修改 |
| `src/main/bootstrap.js` | 启动清理覆盖 push 聚合 | 修改 |
| `src/main/core/settings-security.js` | 白名单加 `providers.dsh.collectionMode`；sanitize 删 ingest token/push 大键 | 修改 |
| `src/main/core/settings-write.js` | 归一化 `providers.dsh.collectionMode`；historyDays 变更时 prune push | 修改 |
| `src/main/core/settings-reset.js` | 保留 push 账本/注册表/source 状态 | 修改 |
| `src/main/index.js` | 装配 `ingestRuntime`，start/stop/applySetting | 修改 |
| `src/preload/preload.js` | 放行 ingest invoke 通道 | 修改 |
| `src/renderer/js/settings-definitions.js` | 新增 collectionMode select 与 ingest 连接信息项 | 修改 |
| `src/renderer/js/settings-window.js` | 渲染/绑定 ingest 连接信息 | 修改 |
| `test/dsh-usage-records.test.js`、`test/dsh-usage-merge.test.js`、`test/dsh-push-store.test.js`、`test/dsh-ingest-validate.test.js`、`test/dsh-ingest-registry.test.js`、`test/dsh-ingest-apply.test.js`、`test/dsh-ingest-token.test.js`、`test/dsh-ingest-server.test.js`、`test/dsh-ingest-runtime.test.js`、`test/dsh-collection-mode.test.js` | 单元/集成测试 | 新建 |

---

### Task 1: 共享行映射模块 `usage-records.js`

**Files:**
- Create: `src/main/providers/dsh/usage-records.js`
- Modify: `src/main/providers/dsh/telemetrylog.js`
- Test: `test/dsh-usage-records.test.js`

**Interfaces:**
- Consumes: `../../core/locallog` 的 `normalizeTimestampMs` / `localDayStr` / `rollupDaily` / `incrementDiagnostic`；`../../pricing` 的 `calcDshCost` / `getDshModelPrice`。
- Produces:
  - `mapRowObjectToRecord(data, diagnostics, nowMs) -> UsageRecord | null`（非法行返回 null 并计 diagnostics）
  - `parseTelemetryLine(line, diagnostics, nowMs) -> UsageRecord | null`
  - `rollupDshRecords(records, diagnostics, nowMs) -> { usageDaily, usageDailyCost }`

- [ ] **Step 1: 写失败测试**

创建 `test/dsh-usage-records.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mapRowObjectToRecord,
  parseTelemetryLine,
  rollupDshRecords
} = require('../src/main/providers/dsh/usage-records');

const TS = Date.UTC(2026, 7, 14, 2, 0, 0);

test('mapRowObjectToRecord maps the four buckets into the UsageRecord shape', () => {
  const diagnostics = {};
  const rec = mapRowObjectToRecord({
    v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro',
    inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000, cacheWriteTokens: 100
  }, diagnostics, TS);
  assert.ok(rec);
  assert.equal(rec.ts, TS);
  assert.equal(rec.currency, 'CNY');
  assert.deepEqual(rec.usage, { input: 1100, cached: 3000, output: 2000, total: 6100 });
  assert.ok(rec.cost > 0);
  assert.match(rec.eventFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('mapRowObjectToRecord rejects invalid rows with diagnostics', () => {
  const diagnostics = {};
  assert.equal(mapRowObjectToRecord({ v: 2, time: TS, sessionId: 's', inputTokens: 1, outputTokens: 1 }, diagnostics, TS), null);
  assert.equal(diagnostics.unknownRowVersion, 1);
  assert.equal(mapRowObjectToRecord({ v: 1, time: TS, sessionId: '', inputTokens: 1, outputTokens: 1 }, diagnostics, TS), null);
  assert.equal(diagnostics.invalidSessionId, 1);
});

test('parseTelemetryLine delegates JSON parsing to the shared mapper', () => {
  const rec = parseTelemetryLine(JSON.stringify({
    v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro',
    inputTokens: 5, outputTokens: 6
  }), {}, TS);
  assert.ok(rec);
  assert.deepEqual(rec.usage, { input: 5, cached: 0, output: 6, total: 11 });
});

test('rollupDshRecords rolls daily keys and costs with the dsh prefix', () => {
  const a = mapRowObjectToRecord({ v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, {}, TS);
  const b = mapRowObjectToRecord({ v: 1, time: TS + 3600_000, sessionId: 's2', model: 'deepseek-v4-pro', inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, {}, TS);
  const rolled = rollupDshRecords([a, b], {}, TS);
  assert.deepEqual(rolled.usageDaily['dsh:2026-08-14'], { input: 150, cached: 0, output: 200, total: 350 });
  assert.ok(Number.isFinite(rolled.usageDailyCost['dsh:2026-08-14']) && rolled.usageDailyCost['dsh:2026-08-14'] > 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-usage-records.test.js`
Expected: FAIL（模块不存在 `Cannot find module`）。

- [ ] **Step 3: 实现模块**

创建 `src/main/providers/dsh/usage-records.js`（内容从 `telemetrylog.js` 的 `parseTelemetryLine` 原样抽出）：

```js
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
  if (data.v === undefined) { incrementDiagnostic(diagnostics, 'missingRowVersion'); return null; }
  if (data.v !== 1) { incrementDiagnostic(diagnostics, 'unknownRowVersion'); return null; }
  if (typeof data.time !== 'number' || !Number.isSafeInteger(data.time)) {
    incrementDiagnostic(diagnostics, 'invalidTimestamp');
    return null;
  }
  const ts = normalizeTimestampMs(data.time, nowMs);
  if (ts === null) { incrementDiagnostic(diagnostics, 'invalidTimestamp'); return null; }
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
  if (![input, output, cacheRead, cacheWrite].every((n) => Number.isSafeInteger(n) && n >= 0)) {
    incrementDiagnostic(diagnostics, 'invalidTokenCount');
    return null;
  }
  const model = typeof data.model === 'string' && data.model.length > 0 ? data.model : 'unknown';
  if (!getDshModelPrice(model, ts)) incrementDiagnostic(diagnostics, 'unknownModel');
  const record = {
    ts,
    model,
    currency: 'CNY',
    usage: {
      input: input + cacheWrite,
      cached: cacheRead,
      output,
      total: input + cacheWrite + cacheRead + output
    },
    cost: calcDshCost(model, input, output, cacheRead, cacheWrite, ts)
  };
  record.eventFingerprint = 'sha256:' + crypto.createHash('sha256')
    .update([new Date(ts).toISOString(), data.sessionId, model, input, output, cacheRead, cacheWrite].join('\0'), 'utf8')
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
```

修改 `src/main/providers/dsh/telemetrylog.js`：
- 删除文件内 `parseTelemetryLine` 函数体（保留导出名）；
- 顶部 `require('./usage-records')`；
- `readLocalLog` 中原来的 rollup 段替换为 `rollupDshRecords`：

```js
const { parseTelemetryLine, rollupDshRecords } = require('./usage-records');
// 删除本文件中的 parseTelemetryLine 定义与不再使用的 crypto import。

// readLocalLog 中 records.length 分支替换为:
if (records.length && store) {
  const { filterUsageDaily } = require('../../core/usage-retention');
  const rolledAll = rollupDshRecords(records, diagnostics, nowMs);
  const daily = opts && opts.retainAll
    ? rolledAll.usageDaily
    : filterUsageDaily(rolledAll.usageDaily, store.get('data.historyDays'), nowMs);
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
  const costDaily = opts && opts.retainAll
    ? rolledAll.usageDailyCost
    : filterUsageDaily(rolledAll.usageDailyCost, store.get('data.historyDays'), nowMs);
  Object.keys(costDaily).forEach((key) => {
    usageDailyCost[key] = Number(usageDailyCost[key] || 0) + Number(costDaily[key]);
  });
  commitTelemetryScanState(store, usageDaily, usageDailyCost, batch.cursors || {});
}
```

- [ ] **Step 4: 运行新测试与既有 dsh 测试**

Run: `node --test test/dsh-usage-records.test.js test/dsh-telemetrylog.test.js test/dsh-pricing.test.js`
Expected: PASS。

- [ ] **Step 5: 全量测试并提交**

Run: `npm test`
Expected: 全绿。

```bash
git add src/main/providers/dsh/usage-records.js src/main/providers/dsh/telemetrylog.js test/dsh-usage-records.test.js
git commit -m "refactor: extract shared DSH usage record mapper for ingest"
```

---

### Task 2: 有效聚合合并核心 `dsh-usage-merge.js`

**Files:**
- Create: `src/main/core/dsh-usage-merge.js`
- Test: `test/dsh-usage-merge.test.js`

**Interfaces:**
- Consumes: `./usage-retention` 的 `filterUsageDaily`。
- Produces:
  - `PUSH_USAGE_KEY = 'usageDailyPush'`、`PUSH_COST_KEY = 'usageDailyCostPush'`
  - `mergeDshKeys(localDaily, pushDaily) -> object`（保留本地所有 provider 键，把 `dsh:` 键求和）
  - `effectiveUsageDaily(store, historyDays, nowMs) -> object`
  - `effectiveUsageDailyCost(store, historyDays, nowMs) -> object`
  - `effectiveDshDayTotal(store, dayKey) -> number`

- [ ] **Step 1: 写失败测试**

`test/dsh-usage-merge.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PUSH_USAGE_KEY, PUSH_COST_KEY,
  mergeDshKeys, effectiveUsageDaily, effectiveUsageDailyCost, effectiveDshDayTotal
} = require('../src/main/core/dsh-usage-merge');

const local = {
  'dsh:2026-08-14': { input: 100, cached: 0, output: 200, total: 300 },
  'codex:2026-08-14': { input: 5, cached: 0, output: 1, total: 6 }
};
const push = {
  'dsh:2026-08-14': { input: 10, cached: 20, output: 30, total: 60 }
};

test('mergeDshKeys sums dsh rows and keeps other providers untouched', () => {
  assert.deepEqual(mergeDshKeys(local, push)['dsh:2026-08-14'],
    { input: 110, cached: 20, output: 230, total: 360 });
  assert.deepEqual(mergeDshKeys(local, push)['codex:2026-08-14'], local['codex:2026-08-14']);
});

test('effective helpers read merged and filtered store data', () => {
  const store = {
    get(k) {
      if (k === 'usageDaily') return local;
      if (k === 'usageDailyCost') return { 'dsh:2026-08-14': 0.1 };
      if (k === PUSH_USAGE_KEY) return push;
      if (k === PUSH_COST_KEY) return { 'dsh:2026-08-14': 0.2 };
      return undefined;
    }
  };
  assert.equal(effectiveUsageDaily(store, 7, Date.UTC(2026, 7, 14, 4, 0, 0))['dsh:2026-08-14'].total, 360);
  assert.equal(effectiveUsageDailyCost(store, 7, Date.UTC(2026, 7, 14, 4, 0, 0))['dsh:2026-08-14'], 0.3);
  assert.equal(effectiveDshDayTotal(store, '2026-08-14'), 360);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-usage-merge.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```js
// 本地文件聚合(usageDaily/usageDailyCost)与 push 聚合(usageDailyPush/usageDailyCostPush)
// 的合并纯函数层。展示层、token-speed、MCP 投影统一从这里读 dsh 有效值。
const { filterUsageDaily } = require('./usage-retention');

const PUSH_USAGE_KEY = 'usageDailyPush';
const PUSH_COST_KEY = 'usageDailyCostPush';
const DSH_PREFIX = 'dsh:';

function emptyDailyRow() { return { input: 0, cached: 0, output: 0, total: 0 }; }

function mergeDshKeys(localDaily, pushDaily) {
  const merged = JSON.parse(JSON.stringify(localDaily && typeof localDaily === 'object' ? localDaily : {}));
  Object.keys(pushDaily && typeof pushDaily === 'object' ? pushDaily : {}).forEach((key) => {
    if (!key.startsWith(DSH_PREFIX)) return;
    const prev = merged[key] || emptyDailyRow();
    const add = pushDaily[key] || emptyDailyRow();
    merged[key] = {
      input: (Number(prev.input) || 0) + (Number(add.input) || 0),
      cached: (Number(prev.cached) || 0) + (Number(add.cached) || 0),
      output: (Number(prev.output) || 0) + (Number(add.output) || 0),
      total: (Number(prev.total) || 0) + (Number(add.total) || 0)
    };
  });
  return merged;
}

function mergeDshCosts(localCost, pushCost) {
  const merged = JSON.parse(JSON.stringify(localCost && typeof localCost === 'object' ? localCost : {}));
  Object.keys(pushCost && typeof pushCost === 'object' ? pushCost : {}).forEach((key) => {
    if (!key.startsWith(DSH_PREFIX)) return;
    merged[key] = Number(merged[key] || 0) + Number(pushCost[key] || 0);
  });
  return merged;
}

function readStore(store, key) {
  return (store && typeof store.get === 'function') ? store.get(key) : undefined;
}

function effectiveUsageDaily(store, historyDays, nowMs) {
  const merged = mergeDshKeys(readStore(store, 'usageDaily'), readStore(store, PUSH_USAGE_KEY));
  return filterUsageDaily(merged, historyDays, nowMs);
}

function effectiveUsageDailyCost(store, historyDays, nowMs) {
  const merged = mergeDshCosts(readStore(store, 'usageDailyCost'), readStore(store, PUSH_COST_KEY));
  return filterUsageDaily(merged, historyDays, nowMs);
}

function effectiveDshDayTotal(store, dayKey) {
  const local = readStore(store, 'usageDaily') || {};
  const push = readStore(store, PUSH_USAGE_KEY) || {};
  const l = local[DSH_PREFIX + dayKey];
  const p = push[DSH_PREFIX + dayKey];
  return (Number(l && l.total) || 0) + (Number(p && p.total) || 0);
}

module.exports = {
  PUSH_USAGE_KEY, PUSH_COST_KEY,
  mergeDshKeys, mergeDshCosts,
  effectiveUsageDaily, effectiveUsageDailyCost,
  effectiveDshDayTotal
};
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/dsh-usage-merge.test.js`
Expected: PASS。

- [ ] **Step 5: 全量测试并提交**

Run: `npm test`，然后：

```bash
git add src/main/core/dsh-usage-merge.js test/dsh-usage-merge.test.js
git commit -m "feat: add effective DSH usage merge for local and push aggregates"
```

---

### Task 3: push 聚合原子提交 `push-store.js`

**Files:**
- Create: `src/main/providers/dsh/push-store.js`
- Test: `test/dsh-push-store.test.js`

**Interfaces:**
- Consumes: `../usage-records` 的 `rollupDshRecords`；`../../core/dsh-usage-merge` 的 `PUSH_USAGE_KEY` / `PUSH_COST_KEY` / `mergeDshKeys` / `mergeDshCosts`；`../../core/usage-retention` 的 `filterUsageDaily`。
- Produces: `commitDshPushRecords(store, records, options) -> { records, usageDaily, usageDailyCost }`，`options = { diagnostics, nowMs, retainAll = false, extraWrites = {} }`。extraWrites（如注册表/source 状态）与 push 聚合在同一 store 快照内提交。

- [ ] **Step 1: 写失败测试**

`test/dsh-push-store.test.js`（store mock 支持 `set(object)` 与 `store` 快照两种路径）：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { commitDshPushRecords } = require('../src/main/providers/dsh/push-store');
const { mapRowObjectToRecord } = require('../src/main/providers/dsh/usage-records');

function makeStore(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  return {
    get(key) { return key.split('.').reduce((v, p) => (v == null ? undefined : v[p]), data); },
    set(key, value) {
      if (typeof key === 'object' && key !== null) {
        Object.keys(key).forEach((k) => this.set(k, key[k]));
        return;
      }
      const parts = key.split('.'); let cur = data;
      while (parts.length > 1) { const p = parts.shift(); if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}; cur = cur[p]; }
      cur[parts[0]] = value;
    }
  };
}

const TS = Date.UTC(2026, 7, 14, 2, 0, 0);

test('commitDshPushRecords writes push aggregates and extraWrites atomically', () => {
  const store = makeStore({ usageDailyPush: {}, usageDailyCostPush: {}, data: { historyDays: 30 } });
  const rec = mapRowObjectToRecord({ v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, {}, TS);
  commitDshPushRecords(store, [rec], {
    diagnostics: {}, nowMs: TS, extraWrites: { 'ingest.dsh.batchRegistry': { src1: { b1: { rowCount: 1, bodyHash: 'x', acceptedAt: TS } } } }
  });
  assert.deepEqual(store.get('usageDailyPush')['dsh:2026-08-14'], { input: 100, cached: 0, output: 200, total: 300 });
  assert.ok(store.get('usageDailyCostPush')['dsh:2026-08-14'] > 0);
  assert.equal(store.get('ingest.dsh.batchRegistry').src1.b1.rowCount, 1);
});

test('commitDshPushRecords uses store snapshot when present', () => {
  // 模拟 electron-store:data 是内部快照,get 从快照读,写 store 属性整体替换快照。
  const data = { usageDailyPush: {}, usageDailyCostPush: {} };
  const store = {
    get(key) { return key.split('.').reduce((v, p) => (v == null ? undefined : v[p]), data); },
    set(key, value) {
      if (typeof key === 'object' && key !== null) { Object.keys(key).forEach((k) => this.set(k, key[k])); return; }
      const parts = key.split('.'); let cur = data;
      while (parts.length > 1) { const p = parts.shift(); if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}; cur = cur[p]; }
      cur[parts[0]] = value;
    }
  };
  Object.defineProperty(store, 'store', {
    get() { return data; },
    set(next) { Object.keys(next).forEach((k) => { delete data[k]; }); Object.assign(data, next); }
  });
  const rec = mapRowObjectToRecord({ v: 1, time: TS, sessionId: 's2', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, {}, TS);
  commitDshPushRecords(store, [rec], { diagnostics: {}, nowMs: TS });
  assert.equal(store.get('usageDailyPush')['dsh:2026-08-14'].total, 2);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-push-store.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```js
// 把 ingest 记录写入 push 聚合存储。与 batch 注册表/source 状态在同一快照提交,
// 避免 "已记账但未确认" 或 "已确认但未记账" 的中间状态。
const { rollupDshRecords } = require('./usage-records');
const {
  PUSH_USAGE_KEY, PUSH_COST_KEY, mergeDshKeys, mergeDshCosts
} = require('../../core/dsh-usage-merge');
const { filterUsageDaily } = require('../../core/usage-retention');

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function commitDshPushRecords(store, records, options = {}) {
  const diagnostics = options.diagnostics || {};
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const retainAll = options.retainAll === true;
  const extraWrites = options.extraWrites && typeof options.extraWrites === 'object' ? options.extraWrites : {};

  const rolled = rollupDshRecords(records, diagnostics, nowMs);
  const historyDays = store && typeof store.get === 'function' ? store.get('data.historyDays') : undefined;
  const usageDailyAdd = retainAll ? rolled.usageDaily : filterUsageDaily(rolled.usageDaily, historyDays, nowMs);
  const usageDailyCostAdd = retainAll ? rolled.usageDailyCost : filterUsageDaily(rolled.usageDailyCost, historyDays, nowMs);
  const usageDaily = mergeDshKeys(store.get('usageDailyPush'), usageDailyAdd);
  const usageDailyCost = mergeDshCosts(store.get('usageDailyCostPush'), usageDailyCostAdd);

  const snapshot = store && store.store;
  if (snapshot && typeof snapshot === 'object') {
    const copy = cloneValue(snapshot);
    copy[PUSH_USAGE_KEY] = usageDaily;
    copy[PUSH_COST_KEY] = usageDailyCost;
    Object.keys(extraWrites).forEach((key) => { copy[key] = extraWrites[key]; });
    store.store = copy;
  } else {
    const writes = {
      [PUSH_USAGE_KEY]: usageDaily,
      [PUSH_COST_KEY]: usageDailyCost
    };
    Object.keys(extraWrites).forEach((key) => { writes[key] = extraWrites[key]; });
    store.set(writes);
  }
  return { records, usageDaily, usageDailyCost };
}

module.exports = { commitDshPushRecords };
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/dsh-push-store.test.js`
Expected: PASS。

- [ ] **Step 5: 全量测试并提交**

Run: `npm test`，然后：

```bash
git add src/main/providers/dsh/push-store.js test/dsh-push-store.test.js
git commit -m "feat: commit DSH ingest records to push aggregates atomically"
```

---

### Task 4: ingest 校验与错误模型

**Files:**
- Create: `src/main/providers/dsh/ingest/validate.js`
- Test: `test/dsh-ingest-validate.test.js`

**Interfaces:**
- Consumes: `../../usage-records` 的 `mapRowObjectToRecord`；`../../../../core/locallog` 的 `normalizeTimestampMs`。
- Produces:
  - `class IngestError extends Error`（`status`、`code`、`index`）
  - `normalizeBatchEnvelope(body) -> { sourceId, rootId, batchId, sentAt, heartbeat, rows }`
  - `mapBatchRows(rows, diagnostics, nowMs) -> UsageRecord[]`
  - `computeBodyHash(rows) -> string`

- [ ] **Step 1: 写失败测试**

`test/dsh-ingest-validate.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IngestError, normalizeBatchEnvelope, mapBatchRows, computeBodyHash
} = require('../src/main/providers/dsh/ingest/validate');

const TS = Date.UTC(2026, 7, 14, 2, 0, 0);
const ROOT = 'root:' + 'a'.repeat(64);
const BATCH = 'sha256:' + 'b'.repeat(64);

function validEnvelope(over = {}) {
  return Object.assign({
    sourceId: 'laptop-1', rootId: ROOT, batchId: BATCH, sentAt: TS,
    rows: [{ v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }]
  }, over);
}

test('accepts a valid ordinary batch', () => {
  const env = normalizeBatchEnvelope(validEnvelope());
  assert.equal(env.sourceId, 'laptop-1');
  assert.equal(env.heartbeat, false);
  assert.equal(env.rows.length, 1);
});

test('rejects invalid sourceId/rootId/batchId with the documented codes', () => {
  for (const [patch, code] of [
    [{ sourceId: 'bad source' }, 'invalid-source-id'],
    [{ rootId: 'nope' }, 'invalid-root-id'],
    [{ batchId: 'nope' }, 'invalid-batch-id']
  ]) {
    assert.throws(() => normalizeBatchEnvelope(validEnvelope(patch)), (e) => e instanceof IngestError && e.status === 400 && e.code === code);
  }
});

test('heartbeat forbids batchId and non-empty rows', () => {
  assert.throws(() => normalizeBatchEnvelope(validEnvelope({ heartbeat: true, batchId: BATCH })), (e) => e.code === 'invalid-heartbeat');
  assert.throws(() => normalizeBatchEnvelope(validEnvelope({ heartbeat: true })), (e) => e.code === 'invalid-heartbeat');
  const env = normalizeBatchEnvelope({ sourceId: 'laptop-1', rootId: ROOT, sentAt: TS, heartbeat: true, rows: [] });
  assert.equal(env.heartbeat, true);
  assert.equal(env.rows.length, 0);
});

test('mapBatchRows rejects the whole batch with invalid-row index', () => {
  const rows = validEnvelope().rows.concat([{ v: 1, time: TS, sessionId: 's2', inputTokens: -1, outputTokens: 1 }]);
  assert.throws(() => mapBatchRows(rows, {}, TS), (e) => e.code === 'invalid-row' && e.index === 1);
});

test('computeBodyHash is stable across key order but differs by row order/content', () => {
  const rows = [{ inputTokens: 1, v: 1, time: TS, sessionId: 's' }];
  assert.equal(computeBodyHash(rows), computeBodyHash([{ v: 1, time: TS, sessionId: 's', inputTokens: 1 }]));
  assert.notEqual(computeBodyHash(rows), computeBodyHash([{ v: 1, time: TS, sessionId: 's', inputTokens: 2 }]));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-ingest-validate.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```js
// HTTP envelope/rows 校验。整批 all-or-nothing:任一字段非法即抛 IngestError(400)。
const crypto = require('node:crypto');
const { mapRowObjectToRecord } = require('../usage-records');
const { normalizeTimestampMs } = require('../../../core/locallog');

const SOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ROOT_ID_PATTERN = /^root:[0-9a-f]{64}$/;
const BATCH_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_BATCH_ROWS = 1000;

class IngestError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'IngestError';
    this.status = status;
    this.code = code;
    if (extra.index !== undefined) this.index = extra.index;
  }
}

function fail(status, code, message, extra) {
  throw new IngestError(status, code, message, extra);
}

function normalizeBatchEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(400, 'invalid-envelope', 'body must be a JSON object');
  }
  if (typeof body.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(body.sourceId)) {
    fail(400, 'invalid-source-id', 'sourceId must match [A-Za-z0-9._-]{1,64}');
  }
  if (typeof body.rootId !== 'string' || !ROOT_ID_PATTERN.test(body.rootId)) {
    fail(400, 'invalid-root-id', 'rootId must be root:<64 hex>');
  }
  if (typeof body.sentAt !== 'number' || !Number.isSafeInteger(body.sentAt)) {
    fail(400, 'invalid-sent-at', 'sentAt must be a safe integer epoch-ms');
  }
  const heartbeat = body.heartbeat === true;
  if (body.heartbeat !== undefined && typeof body.heartbeat !== 'boolean') {
    fail(400, 'invalid-heartbeat', 'heartbeat must be a boolean');
  }
  const rows = body.rows === undefined ? undefined : body.rows;
  if (heartbeat) {
    if (body.batchId !== undefined) fail(400, 'invalid-heartbeat', 'heartbeat request must not carry batchId');
    if (rows !== undefined && (!Array.isArray(rows) || rows.length !== 0)) {
      fail(400, 'invalid-heartbeat', 'heartbeat rows must be omitted or empty');
    }
    return { sourceId: body.sourceId, rootId: body.rootId, sentAt: body.sentAt, heartbeat: true, rows: [] };
  }
  if (typeof body.batchId !== 'string' || !BATCH_ID_PATTERN.test(body.batchId)) {
    fail(400, 'invalid-batch-id', 'batchId must be sha256:<64 hex>');
  }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_BATCH_ROWS) {
    fail(400, 'invalid-rows', 'rows must be an array of 1..1000 entries');
  }
  return { sourceId: body.sourceId, rootId: body.rootId, batchId: body.batchId, sentAt: body.sentAt, heartbeat: false, rows };
}

function mapBatchRows(rows, diagnostics, nowMs) {
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') fail(400, 'invalid-row', 'row must be an object', { index });
    if (row.v !== 1) fail(400, 'invalid-row', 'rows[].v must be 1', { index });
    if (typeof row.time !== 'number' || !Number.isSafeInteger(row.time) || normalizeTimestampMs(row.time, nowMs) === null) {
      fail(400, 'invalid-row', 'rows[].time must be an epoch-ms safe integer inside [2000-01-01, now+24h]', { index });
    }
    const record = mapRowObjectToRecord(row, diagnostics, nowMs);
    if (!record) fail(400, 'invalid-row', 'row is invalid', { index });
    return record;
  });
}

function computeBodyHash(rows) {
  const canonical = rows.map((row) => {
    const out = {};
    ['v', 'time', 'sessionId', 'cwd', 'model', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      .forEach((key) => { if (row[key] !== undefined) out[key] = row[key]; });
    Object.keys(row).filter((key) => !out[key] && !['v', 'time', 'sessionId', 'cwd', 'model', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].includes(key))
      .sort()
      .forEach((key) => { out[key] = row[key]; });
    return out;
  });
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

module.exports = { IngestError, normalizeBatchEnvelope, mapBatchRows, computeBodyHash };
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/dsh-ingest-validate.test.js`
Expected: PASS。

- [ ] **Step 5: 全量测试并提交**

Run: `npm test`，然后：

```bash
git add src/main/providers/dsh/ingest/validate.js test/dsh-ingest-validate.test.js
git commit -m "feat: validate DSH ingest batches and heartbeat envelopes"
```

---

### Task 5: 持久化幂等注册表 `registry.js`

**Files:**
- Create: `src/main/providers/dsh/ingest/registry.js`
- Test: `test/dsh-ingest-registry.test.js`

**Interfaces:**
- Consumes: 无外部模块。
- Produces:
  - `REGISTRY_KEY = 'ingest.dsh.batchRegistry'`
  - `DEFAULT_BATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000`
  - `MAX_REGISTRY_ENTRIES = 200000`
  - `pruneRegistry(registry, nowMs, ttlMs) -> { registry, pruned }`
  - `classifyBatch(registry, input, nowMs, ttlMs) -> { status: 'new'|'duplicate'|'conflict'|'full', registry, existing? }`
    `input = { sourceId, batchId, rowCount, bodyHash }`

- [ ] **Step 1: 写失败测试**

`test/dsh-ingest-registry.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REGISTRY_KEY, DEFAULT_BATCH_TTL_MS, MAX_REGISTRY_ENTRIES,
  pruneRegistry, classifyBatch
} = require('../src/main/providers/dsh/ingest/registry');

const NOW = Date.UTC(2026, 7, 16, 0, 0, 0);
const INPUT = { sourceId: 'src1', batchId: 'sha256:' + 'a'.repeat(64), rowCount: 2, bodyHash: 'hash-a' };

test('new batch is classified as new and registry gets the entry', () => {
  const r = classifyBatch({}, INPUT, NOW, DEFAULT_BATCH_TTL_MS);
  assert.equal(r.status, 'new');
  assert.equal(r.registry.src1[INPUT.batchId].rowCount, 2);
  assert.equal(r.registry.src1[INPUT.batchId].bodyHash, 'hash-a');
  assert.equal(r.registry.src1[INPUT.batchId].acceptedAt, NOW);
});

test('same key and bodyHash is duplicate; different bodyHash is conflict', () => {
  const first = classifyBatch({}, INPUT, NOW, DEFAULT_BATCH_TTL_MS).registry;
  assert.equal(classifyBatch(first, INPUT, NOW, DEFAULT_BATCH_TTL_MS).status, 'duplicate');
  assert.equal(classifyBatch(first, { ...INPUT, bodyHash: 'hash-b' }, NOW, DEFAULT_BATCH_TTL_MS).status, 'conflict');
});

test('expired entries are pruned before classification', () => {
  const first = classifyBatch({}, INPUT, NOW - DEFAULT_BATCH_TTL_MS - 1, DEFAULT_BATCH_TTL_MS).registry;
  const r = classifyBatch(first, INPUT, NOW, DEFAULT_BATCH_TTL_MS);
  assert.equal(r.status, 'new');
  assert.equal(Object.keys(r.registry.src1).length, 1);
});

test('registry full refuses new batches instead of evicting unexpired entries', () => {
  const registry = { src1: {} };
  for (let i = 0; i < MAX_REGISTRY_ENTRIES; i++) registry.src1['b' + i] = { acceptedAt: NOW, bodyHash: 'h', rowCount: 1 };
  const r = classifyBatch(registry, INPUT, NOW, DEFAULT_BATCH_TTL_MS);
  assert.equal(r.status, 'full');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-ingest-registry.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```js
// (sourceId, batchId) 幂等注册表。持久化在 store 键 ingest.dsh.batchRegistry。
// 容量满时只淘汰过期项;没有过期项可淘汰就拒绝新 batch(registry-full)。
const REGISTRY_KEY = 'ingest.dsh.batchRegistry';
const DEFAULT_BATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REGISTRY_ENTRIES = 200000;

function countEntries(registry) {
  let n = 0;
  Object.keys(registry || {}).forEach((sourceId) => { n += Object.keys(registry[sourceId] || {}).length; });
  return n;
}

function pruneRegistry(registry, nowMs, ttlMs = DEFAULT_BATCH_TTL_MS) {
  const out = {};
  let pruned = 0;
  Object.keys(registry || {}).forEach((sourceId) => {
    const source = registry[sourceId] || {};
    Object.keys(source).forEach((batchId) => {
      const entry = source[batchId] || {};
      if (!Number.isFinite(Number(entry.acceptedAt)) || nowMs - Number(entry.acceptedAt) > ttlMs) {
        pruned++;
        return;
      }
      out[sourceId] = out[sourceId] || {};
      out[sourceId][batchId] = entry;
    });
  });
  return { registry: out, pruned };
}

function classifyBatch(registry, input, nowMs, ttlMs = DEFAULT_BATCH_TTL_MS) {
  const { registry: next, pruned } = pruneRegistry(registry, nowMs, ttlMs);
  const source = next[input.sourceId] || {};
  const existing = source[input.batchId];
  if (existing) {
    return existing.bodyHash === input.bodyHash
      ? { status: 'duplicate', registry: next, existing }
      : { status: 'conflict', registry: next, existing };
  }
  if (countEntries(next) >= MAX_REGISTRY_ENTRIES) return { status: 'full', registry: next };
  next[input.sourceId] = Object.assign({}, source, {
    [input.batchId]: {
      rowCount: input.rowCount,
      bodyHash: input.bodyHash,
      acceptedAt: nowMs
    }
  });
  return { status: 'new', registry: next };
}

module.exports = {
  REGISTRY_KEY, DEFAULT_BATCH_TTL_MS, MAX_REGISTRY_ENTRIES,
  pruneRegistry, classifyBatch
};
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/dsh-ingest-registry.test.js`
Expected: PASS。

- [ ] **Step 5: 全量测试并提交**

Run: `npm test`，然后：

```bash
git add src/main/providers/dsh/ingest/registry.js test/dsh-ingest-registry.test.js
git commit -m "feat: add persistent DSH ingest idempotency registry"
```

---

### Task 6: ingest 业务入口 `apply.js`

**Files:**
- Create: `src/main/providers/dsh/ingest/apply.js`
- Test: `test/dsh-ingest-apply.test.js`

**Interfaces:**
- Consumes: Task 1/3/4/5 的导出；store `get`/`set`；可注入 `commitExclusive`（默认 `(fn) => fn()`）与 `now`。
- Produces:
  - `SOURCES_KEY = 'ingest.dsh.sources'`
  - `createIngestApply({ store, commitExclusive, now, onAccepted, onRejected }) -> { handle(body) }`
  - `handle(body)` 返回 `{ ok: true, heartbeat?: true, accepted, duplicates }`；错误抛 `IngestError`。

- [ ] **Step 1: 写失败测试**

`test/dsh-ingest-apply.test.js`（重点：新 batch 落 push 账本 + 注册表 + source 状态；重复不重记；heartbeat 只续租）：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createIngestApply, SOURCES_KEY } = require('../src/main/providers/dsh/ingest/apply');
const { REGISTRY_KEY } = require('../src/main/providers/dsh/ingest/registry');

function makeStore(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  return {
    get(key) { return key.split('.').reduce((v, p) => (v == null ? undefined : v[p]), data); },
    set(key, value) {
      if (typeof key === 'object' && key !== null) { Object.keys(key).forEach((k) => this.set(k, key[k])); return; }
      const parts = key.split('.'); let cur = data;
      while (parts.length > 1) { const p = parts.shift(); if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}; cur = cur[p]; }
      cur[parts[0]] = value;
    }
  };
}
const TS = Date.UTC(2026, 7, 14, 2, 0, 0);
const ROOT = 'root:' + 'a'.repeat(64);
const BATCH = 'sha256:' + 'b'.repeat(64);
function envelope(over = {}) {
  return Object.assign({
    sourceId: 'src-1', rootId: ROOT, batchId: BATCH, sentAt: TS,
    rows: [{ v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }]
  }, over);
}

test('new batch commits push ledger, registry and source state once', async () => {
  const store = makeStore({ usageDailyPush: {}, usageDailyCostPush: {}, 'data.historyDays': 30 });
  const accepted = [];
  const apply = createIngestApply({ store, now: () => TS, onAccepted: (r) => accepted.push(r) });
  const result = await apply.handle(envelope());
  assert.deepEqual(result, { ok: true, accepted: 1, duplicates: 0 });
  assert.equal(store.get('usageDailyPush')['dsh:2026-08-14'].total, 300);
  assert.equal(store.get(REGISTRY_KEY).src1[BATCH].rowCount, 1);
  assert.equal(store.get(SOURCES_KEY)['src-1'].rootId, ROOT);
  assert.equal(accepted.length, 1);
});

test('retry with the same batch is idempotent and does not double count', async () => {
  const store = makeStore({ usageDailyPush: {}, usageDailyCostPush: {}, 'data.historyDays': 30 });
  const apply = createIngestApply({ store, now: () => TS });
  await apply.handle(envelope());
  const second = await apply.handle(envelope());
  assert.deepEqual(second, { ok: true, accepted: 0, duplicates: 1 });
  assert.equal(store.get('usageDailyPush')['dsh:2026-08-14'].total, 300);
});

test('same key with different rows is a 409 conflict', async () => {
  const store = makeStore({ usageDailyPush: {}, usageDailyCostPush: {}, 'data.historyDays': 30 });
  const apply = createIngestApply({ store, now: () => TS });
  await apply.handle(envelope());
  await assert.rejects(apply.handle(envelope({ rows: [{ v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }] })),
    (e) => e.status === 409 && e.code === 'batch-conflict');
});

test('heartbeat updates source lease without touching ledger or registry', async () => {
  const store = makeStore({});
  const apply = createIngestApply({ store, now: () => TS });
  const result = await apply.handle({ sourceId: 'src-1', rootId: ROOT, sentAt: TS, heartbeat: true, rows: [] });
  assert.deepEqual(result, { ok: true, heartbeat: true });
  assert.equal(store.get(SOURCES_KEY)['src-1'].lastIngestAt, TS);
  assert.equal(store.get('usageDailyPush'), undefined);
  assert.equal(store.get(REGISTRY_KEY), undefined);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-ingest-apply.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```js
// ingest 业务入口。所有写操作(分类/记账/注册表/source 状态)在同一 commitExclusive 内完成。
const { IngestError, normalizeBatchEnvelope, mapBatchRows, computeBodyHash } = require('./validate');
const { commitDshPushRecords } = require('../push-store');
const {
  REGISTRY_KEY, DEFAULT_BATCH_TTL_MS, classifyBatch, pruneRegistry
} = require('./registry');

const SOURCES_KEY = 'ingest.dsh.sources';

function readStore(store, key) {
  return store && typeof store.get === 'function' ? store.get(key) : undefined;
}

function normalizeSources(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function markSourceActive(sources, sourceId, rootId, nowMs, hasBatch) {
  const next = JSON.parse(JSON.stringify(sources));
  const prev = next[sourceId] || {};
  next[sourceId] = {
    rootId,
    lastIngestAt: nowMs,
    ...(hasBatch ? { ingestStartedAt: prev.ingestStartedAt || nowMs } : { ingestStartedAt: prev.ingestStartedAt || null })
  };
  return next;
}

function createIngestApply(options = {}) {
  const store = options.store;
  const commitExclusive = options.commitExclusive || ((fn) => fn());
  const now = options.now || Date.now;
  const onAccepted = options.onAccepted || (() => {});
  const onRejected = options.onRejected || (() => {});

  function commitSources(nextSources) {
    if (store && typeof store.store === 'object') {
      const copy = JSON.parse(JSON.stringify(store.store));
      copy[SOURCES_KEY] = nextSources;
      store.store = copy;
    } else {
      store.set(SOURCES_KEY, nextSources);
    }
  }

  return {
    async handle(body) {
      const nowMs = now();
      const env = normalizeBatchEnvelope(body);
      const sources = normalizeSources(readStore(store, SOURCES_KEY));
      const nextSources = markSourceActive(sources, env.sourceId, env.rootId, nowMs, !env.heartbeat);

      if (env.heartbeat) {
        await commitExclusive(() => commitSources(nextSources));
        return { ok: true, heartbeat: true };
      }

      const diagnostics = {};
      const records = mapBatchRows(env.rows, diagnostics, nowMs);
      const bodyHash = computeBodyHash(env.rows);
      const ttlMs = DEFAULT_BATCH_TTL_MS;
      const outcome = await commitExclusive(async () => {
        const registry = normalizeSources(readStore(store, REGISTRY_KEY));
        const classified = classifyBatch(registry, {
          sourceId: env.sourceId, batchId: env.batchId, rowCount: records.length, bodyHash
        }, nowMs, ttlMs);

        if (classified.status === 'conflict') {
          onRejected({ sourceId: env.sourceId, code: 'batch-conflict' });
          throw new IngestError(409, 'batch-conflict', 'batchId was already used with different rows');
        }
        if (classified.status === 'full') {
          onRejected({ sourceId: env.sourceId, code: 'registry-full' });
          throw new IngestError(503, 'registry-full', 'batch registry capacity exhausted');
        }
        if (classified.status === 'duplicate') {
          commitSources(markSourceActive(normalizeSources(readStore(store, SOURCES_KEY)), env.sourceId, env.rootId, nowMs, true));
          return { accepted: 0, duplicates: records.length, changed: false };
        }
        commitDshPushRecords(store, records, {
          diagnostics,
          nowMs,
          extraWrites: {
            [REGISTRY_KEY]: classified.registry,
            [SOURCES_KEY]: nextSources
          }
        });
        return { accepted: records.length, duplicates: 0, changed: true };
      });

      onAccepted({ sourceId: env.sourceId, accepted: outcome.accepted, duplicates: outcome.duplicates, records, changed: outcome.changed });
      return { ok: true, accepted: outcome.accepted, duplicates: outcome.duplicates };
    },

    pruneStoredRegistry() {
      const registry = normalizeSources(readStore(store, REGISTRY_KEY));
      const { registry: pruned } = pruneRegistry(registry, now(), DEFAULT_BATCH_TTL_MS);
      if (store && typeof store.store === 'object') {
        const copy = JSON.parse(JSON.stringify(store.store));
        copy[REGISTRY_KEY] = pruned;
        store.store = copy;
      } else {
        store.set(REGISTRY_KEY, pruned);
      }
    }
  };
}

module.exports = { createIngestApply, SOURCES_KEY };
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/dsh-ingest-apply.test.js`
Expected: PASS。

- [ ] **Step 5: 全量测试并提交**

Run: `npm test`，然后：

```bash
git add src/main/providers/dsh/ingest/apply.js test/dsh-ingest-apply.test.js
git commit -m "feat: apply DSH ingest batches through the shared commit queue"
```

---

### Task 7: ingest token、config、HTTP server 与 runtime

**Files:**
- Create: `src/main/providers/dsh/ingest/token.js`
- Create: `src/main/providers/dsh/ingest/config.js`
- Create: `src/main/providers/dsh/ingest/server.js`
- Create: `src/main/providers/dsh/ingest/index.js`
- Test: `test/dsh-ingest-token.test.js`、`test/dsh-ingest-server.test.js`、`test/dsh-ingest-runtime.test.js`

**Interfaces:**
- Consumes: Task 6 的 `createIngestApply`；Task 5 的 `REGISTRY_KEY`；store；scheduler。
- Produces:
  - `INGEST_TOKEN_KEY = 'ingest.dsh.token'`、`ensureIngestToken(store)`、`rotateIngestToken(store)`
  - `normalizeIngestConfig(raw) -> { enabled, listenHost, basePort, maxPort, batchTtlDays, pushLeaseMs, rateLimitPerSourcePerMinute }`
  - `startIngestServer({ host, basePort, maxPort, token, apply, logger }) -> { port, url, close }`
  - `startIngest({ store, scheduler, broadcast, onUsageObservation, logger }) -> { start, stop, isRunning, getConnectionInfo, rotateToken, getStatus, handle }`

- [ ] **Step 1: 写失败测试**

`test/dsh-ingest-token.test.js`（仿 `test/mcp-token.test.js`）：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { INGEST_TOKEN_KEY, ensureIngestToken, rotateIngestToken } = require('../src/main/providers/dsh/ingest/token');

test('ensureIngestToken generates and persists a 48-char hex token when missing', () => {
  const store = { get: () => undefined, set(k, v) { this[k] = v; } };
  const token = ensureIngestToken(store);
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(store[INGEST_TOKEN_KEY], token);
});

test('rotateIngestToken replaces the stored token', () => {
  const store = { data: { [INGEST_TOKEN_KEY]: 'old' }, get(k) { return this.data[k]; }, set(k, v) { this.data[k] = v; } };
  assert.notEqual(rotateIngestToken(store), 'old');
});
```

`test/dsh-ingest-server.test.js`（重点：401/400/413/429/503、Host 白名单、heartbeat）：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { startIngestServer } = require('../src/main/providers/dsh/ingest/server');

function post(port, { token, host, body, rawSize }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/v1/dsh/usage', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Host': host || ('127.0.0.1:' + port),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : rawSize);
  });
}

test('requires the correct bearer token and loopback Host', async (t) => {
  const apply = { async handle() { return { ok: true, accepted: 1, duplicates: 0 }; } };
  const srv = await startIngestServer({ host: '127.0.0.1', basePort: 0, maxPort: 0, token: 'tok', apply, logger: { log() {}, error() {} } });
  t.after(() => srv.close());
  const noToken = await post(srv.port, { body: {} });
  assert.equal(noToken.status, 401);
  const badHost = await post(srv.port, { token: 'tok', host: 'evil.example.com', body: {} });
  assert.equal(badHost.status, 403);
});

test('heartbeat and valid batch pass through to the apply handler', async (t) => {
  const seen = [];
  const apply = { async handle(body) { seen.push(body); return body.heartbeat ? { ok: true, heartbeat: true } : { ok: true, accepted: 1, duplicates: 0 }; } };
  const srv = await startIngestServer({ host: '127.0.0.1', basePort: 0, maxPort: 0, token: 'tok', apply, logger: { log() {}, error() {} } });
  t.after(() => srv.close());
  const hb = await post(srv.port, { token: 'tok', body: { sourceId: 's1', rootId: 'root:' + 'a'.repeat(64), sentAt: Date.now(), heartbeat: true, rows: [] } });
  assert.deepEqual(hb.body, { ok: true, heartbeat: true });
  const batch = await post(srv.port, { token: 'tok', body: { sourceId: 's1', rootId: 'root:' + 'a'.repeat(64), sentAt: Date.now(), batchId: 'sha256:' + 'b'.repeat(64), rows: [{ v: 1, time: Date.now(), sessionId: 'x', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }] } });
  assert.equal(batch.body.accepted, 1);
});

test('bodies over 1 MiB get 413 before JSON parsing', async (t) => {
  const apply = { async handle() { throw new Error('must not run'); } };
  const srv = await startIngestServer({ host: '127.0.0.1', basePort: 0, maxPort: 0, token: 'tok', apply, logger: { log() {}, error() {} } });
  t.after(() => srv.close());
  const res = await post(srv.port, { token: 'tok', rawSize: Buffer.alloc(1024 * 1024 + 1, 32) });
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'batch-too-large');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-ingest-token.test.js test/dsh-ingest-server.test.js test/dsh-ingest-runtime.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 token/config**

`token.js`（与 MCP token 同格式、独立 key）：

```js
const crypto = require('node:crypto');
const INGEST_TOKEN_KEY = 'ingest.dsh.token';

function generateToken() { return crypto.randomBytes(24).toString('hex'); }
function ensureIngestToken(store) {
  const existing = store.get(INGEST_TOKEN_KEY);
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const token = generateToken();
  store.set(INGEST_TOKEN_KEY, token);
  return token;
}
function rotateIngestToken(store) {
  const token = generateToken();
  store.set(INGEST_TOKEN_KEY, token);
  return token;
}
module.exports = { INGEST_TOKEN_KEY, ensureIngestToken, rotateIngestToken };
```

`config.js`：

```js
const BASE_PORT = 29351;
const MAX_PORT = 29360;
const DEFAULTS = Object.freeze({
  enabled: true,
  listenHost: '127.0.0.1',
  batchTtlDays: 7,
  pushLeaseMs: 600000,
  rateLimitPerSourcePerMinute: 30
});

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeIngestConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled !== false,
    listenHost: typeof source.listenHost === 'string' && source.listenHost.trim() ? source.listenHost.trim() : DEFAULTS.listenHost,
    basePort: positiveNumber(source.port, BASE_PORT),
    maxPort: positiveNumber(source.maxPort, MAX_PORT),
    batchTtlDays: positiveNumber(source.batchTtlDays, DEFAULTS.batchTtlDays),
    pushLeaseMs: Math.max(180000, positiveNumber(source.pushLeaseMs, DEFAULTS.pushLeaseMs)),
    rateLimitPerSourcePerMinute: positiveNumber(source.rateLimitPerSourcePerMinute, DEFAULTS.rateLimitPerSourcePerMinute)
  };
}

module.exports = { BASE_PORT, MAX_PORT, normalizeIngestConfig };
```

- [ ] **Step 4: 实现 HTTP server**

`server.js`：

```js
// 纯 node http ingest server:loopback Host 白名单 + Bearer + 1 MiB + 每 source 限流。
const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOST_PATTERN = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('batch too large'), { status: 413, code: 'batch-too-large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : undefined); }
      catch (_) { reject(Object.assign(new Error('invalid json'), { status: 400, code: 'invalid-json' })); }
    });
    req.on('error', reject);
  });
}

function createRateLimiter(limitPerMinute) {
  const buckets = new Map();
  return {
    tryAcquire(sourceId, nowMs) {
      const bucket = buckets.get(sourceId) || { tokens: limitPerMinute, last: nowMs };
      const elapsedMs = Math.max(0, nowMs - bucket.last);
      bucket.tokens = Math.min(limitPerMinute, bucket.tokens + elapsedMs * (limitPerMinute / 60000));
      bucket.last = nowMs;
      if (bucket.tokens < 1) {
        buckets.set(sourceId, bucket);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / (limitPerMinute / 60000))) };
      }
      bucket.tokens -= 1;
      buckets.set(sourceId, bucket);
      return { allowed: true, retryAfterSeconds: 0 };
    }
  };
}

function createIngestHandler({ token, apply, rateLimitPerSourcePerMinute, listenHost, onError }) {
  const rateLimiter = createRateLimiter(rateLimitPerSourcePerMinute);
  const allowedHost = typeof listenHost === 'string' && !LOOPBACK_HOST_PATTERN.test(listenHost)
    ? listenHost
    : null;
  return async (req, res) => {
    try {
      const reqHost = String(req.headers.host || '');
      const loopbackAllowed = LOOPBACK_HOST_PATTERN.test(reqHost);
      const customAllowed = allowedHost && (reqHost === allowedHost || reqHost.startsWith(allowedHost + ':'));
      if (!loopbackAllowed && !customAllowed) {
        return sendJson(res, 403, { ok: false, code: 'forbidden', message: 'Host not allowed' });
      }
      if (req.url !== '/api/v1/dsh/usage' || req.method !== 'POST') return sendJson(res, 404, { ok: false, code: 'not-found', message: 'Not Found' });
      if (!req.headers.authorization || !timingSafeEqual(req.headers.authorization, 'Bearer ' + token)) {
        return sendJson(res, 401, { ok: false, code: 'unauthorized', message: 'Unauthorized' });
      }
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, code: 'invalid-envelope', message: 'body must be a JSON object' });
      const limit = rateLimiter.tryAcquire(String(body.sourceId || 'unknown'), Date.now());
      if (!limit.allowed) {
        if (typeof onError === 'function') onError('rate-limited');
        res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(limit.retryAfterSeconds) });
        return res.end(JSON.stringify({ ok: false, code: 'rate-limited', message: 'Rate limited' }));
      }
      const result = await apply.handle(body);
      sendJson(res, 200, result);
    } catch (error) {
      const status = Number(error && error.status) || 500;
      const code = error && error.code ? error.code : 'internal';
      if (typeof onError === 'function') onError(code);
      if (res.headersSent || res.destroyed) return;
      const message = status >= 500 ? 'Internal Server Error' : String(error && error.message || 'bad request');
      const payload = { ok: false, code, message };
      if (error && error.index !== undefined) payload.index = error.index;
      sendJson(res, status, payload);
    }
  };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => { server.removeListener('error', onError); resolve(); });
  });
}

async function startIngestServer(options) {
  const host = options.host || '127.0.0.1';
  const basePort = Number(options.basePort) || 0;
  const maxPort = options.maxPort || basePort;
  const handler = createIngestHandler({
    token: options.token,
    apply: options.apply,
    rateLimitPerSourcePerMinute: options.rateLimitPerSourcePerMinute || 30,
    listenHost: host,
    onError: options.onError,
    logger: options.logger || console
  });
  let lastError = null;
  for (let port = basePort; port <= maxPort; port++) {
    const server = http.createServer(handler);
    try {
      await listen(server, host, port || 0);
      const actual = server.address().port;
      return {
        port: actual,
        url: 'http://' + host + ':' + actual + '/api/v1/dsh/usage',
        close: () => new Promise((resolve) => server.close(resolve))
      };
    } catch (error) {
      lastError = error;
      try { server.close(); } catch (_) {}
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    }
  }
  if (basePort) {
    const server = http.createServer(handler);
    await listen(server, host, 0);
    const actual = server.address().port;
    return { port: actual, url: 'http://' + host + ':' + actual + '/api/v1/dsh/usage', close: () => new Promise((resolve) => server.close(resolve)) };
  }
  throw lastError || new Error('no available port');
}

module.exports = { startIngestServer, MAX_BODY_BYTES };
```

- [ ] **Step 5: 实现 runtime**

`index.js`：

```js
// ingest runtime:config/token/apply/server 装配。commitExclusive 与 localLog 共用
// scheduler.runExclusive('dsh','localLog'),保证 ingest/localLog/手动重扫串行。
const { normalizeIngestConfig, BASE_PORT, MAX_PORT } = require('./config');
const { ensureIngestToken, rotateIngestToken, INGEST_TOKEN_KEY } = require('./token');
const { createIngestApply } = require('./apply');
const { startIngestServer } = require('./server');
const { REGISTRY_KEY, pruneRegistry, DEFAULT_BATCH_TTL_MS } = require('./registry');

function startIngest(options = {}) {
  const store = options.store;
  const scheduler = options.scheduler;
  const logger = options.logger || console;
  let server = null;
  let apply = null;
  const diagnostics = Object.create(null);

  function config() {
    return normalizeIngestConfig(store.get('ingest.dsh') || {});
  }

  function commitExclusive(fn) {
    return scheduler && typeof scheduler.runExclusive === 'function'
      ? scheduler.runExclusive('dsh', 'localLog', fn)
      : fn();
  }

  function recordDiagnostic(code) {
    diagnostics[code] = (Number(diagnostics[code]) || 0) + 1;
    store.set('ingest.dsh.diagnostics', JSON.parse(JSON.stringify(diagnostics)));
  }

  async function start() {
    const cfg = config();
    if (server || !cfg.enabled) return;
    apply = createIngestApply({
      store,
      commitExclusive,
      now: options.now || Date.now,
      onAccepted: ({ changed }) => {
        if (!changed) return;
        if (options.onUsageObservation) options.onUsageObservation('dsh', { observedAt: Date.now() });
        if (options.broadcast) options.broadcast('providers:changed', scheduler ? scheduler.getSnapshot() : []);
      },
      onRejected: ({ code }) => recordDiagnostic(code)
    });
    try {
      const registry = store.get(REGISTRY_KEY);
      if (registry && typeof registry === 'object') {
        const { registry: pruned } = pruneRegistry(registry, Date.now(), cfg.batchTtlDays * 24 * 60 * 60 * 1000);
        store.set(REGISTRY_KEY, pruned);
      }
      const token = ensureIngestToken(store);
      server = await startIngestServer({
        host: cfg.listenHost,
        basePort: options.basePort || cfg.basePort,
        maxPort: options.basePort ? options.basePort : cfg.maxPort,
        token, apply, rateLimitPerSourcePerMinute: cfg.rateLimitPerSourcePerMinute,
        onError: (code) => recordDiagnostic(code),
        logger
      });
      logger.log('[ingest] listening at ' + server.url);
    } catch (error) {
      logger.error('[ingest] failed to start: ' + (error && error.message));
      server = null;
    }
  }

  async function stop() {
    if (!server) return;
    const current = server;
    server = null;
    await current.close();
  }

  return {
    start,
    stop,
    isRunning: () => !!server,
    getConnectionInfo() {
      return {
        enabled: config().enabled,
        running: !!server,
        listenHost: config().listenHost,
        port: server ? server.port : null,
        url: server ? server.url : null,
        token: store.get(INGEST_TOKEN_KEY) || null,
        diagnostics: JSON.parse(JSON.stringify(diagnostics))
      };
    },
    async rotateToken() {
      const token = rotateIngestToken(store);
      if (server) { await stop(); await start(); }
      return token;
    },
    handle: (body) => (apply ? apply.handle(body) : Promise.reject(new Error('ingest not running')))
  };
}

module.exports = { startIngest, BASE_PORT, MAX_PORT };
```

- [ ] **Step 6: 运行三个测试**

Run: `node --test test/dsh-ingest-token.test.js test/dsh-ingest-server.test.js test/dsh-ingest-runtime.test.js`
Expected: PASS。若 runtime 测试尚未写出具体用例，本步骤先跑 token/server；runtime 的启动/停用/rotate 用例在 Step 7 补。

- [ ] **Step 7: 补 runtime 测试并全量**

`test/dsh-ingest-runtime.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startIngest } = require('../src/main/providers/dsh/ingest');

function makeStore(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  return {
    get(key) { return key.split('.').reduce((v, p) => (v == null ? undefined : v[p]), data); },
    set(key, value) {
      if (typeof key === 'object' && key !== null) { Object.keys(key).forEach((k) => this.set(k, key[k])); return; }
      const parts = key.split('.'); let cur = data;
      while (parts.length > 1) { const p = parts.shift(); if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}; cur = cur[p]; }
      cur[parts[0]] = value;
    }
  };
}

test('runtime starts with a generated token, reports connection info, and stops', async () => {
  const store = makeStore({});
  const free = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const rt = startIngest({ store, scheduler: null, basePort: free });
  await rt.start();
  assert.equal(rt.isRunning(), true);
  assert.match(rt.getConnectionInfo().url, /\/api\/v1\/dsh\/usage$/);
  await rt.stop();
  assert.equal(rt.isRunning(), false);
});
```

Run: `npm test`，然后：

```bash
git add src/main/providers/dsh/ingest/token.js src/main/providers/dsh/ingest/config.js src/main/providers/dsh/ingest/server.js src/main/providers/dsh/ingest/index.js test/dsh-ingest-token.test.js test/dsh-ingest-server.test.js test/dsh-ingest-runtime.test.js
git commit -m "feat: run DSH ingest HTTP server with bearer auth and rate limit"
```

---

### Task 8: collectionMode、rootId 与 localLog 抑制

**Files:**
- Create: `src/main/core/dsh-collection-mode.js`
- Modify: `src/main/providers/dsh/index.js`
- Modify: `src/main/core/scheduler.js`
- Test: `test/dsh-collection-mode.test.js`；修改 `test/dsh-provider-scheduler.test.js` 增加跳过用例。

**Interfaces:**
- Consumes: `node:path` / `node:crypto`；store。
- Produces:
  - `normalizeDshCollectionMode(value) -> 'auto'|'localLog'|'push'`
  - `deriveDshRootId(rootPath, platform = process.platform) -> 'root:<64 hex>'`
  - `isDshPushSourceActive(source, nowMs, pushLeaseMs) -> boolean`
  - `shouldPollDshLocalLog(store, rootPath, nowMs = Date.now()) -> boolean`
  - dsh provider 新方法 `shouldPollLocalLog(ctx) -> boolean`。

- [ ] **Step 1: 写失败测试**

`test/dsh-collection-mode.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  normalizeDshCollectionMode, deriveDshRootId, isDshPushSourceActive, shouldPollDshLocalLog
} = require('../src/main/core/dsh-collection-mode');

const NOW = Date.UTC(2026, 7, 16, 0, 0, 0);

function store(seed) {
  return { get(k) { return seed[k]; } };
}

test('collection mode defaults to auto and rejects unknown values', () => {
  assert.equal(normalizeDshCollectionMode(undefined), 'auto');
  assert.equal(normalizeDshCollectionMode('push'), 'push');
  assert.equal(normalizeDshCollectionMode('bogus'), 'auto');
});

test('rootId normalizes Windows separators and case', () => {
  const win = deriveDshRootId('C:\\Users\\Me\\.dsh\\telemetry', 'win32');
  const posix = deriveDshRootId('/home/me/.dsh/telemetry', 'linux');
  assert.match(win, /^root:[0-9a-f]{64}$/);
  assert.equal(win, deriveDshRootId('c:/users/me/.dsh/telemetry', 'win32'));
  assert.notEqual(win, posix);
});

test('source is active while lastIngestAt is inside the lease', () => {
  assert.equal(isDshPushSourceActive({ lastIngestAt: NOW - 1000 }, NOW, 600000), true);
  assert.equal(isDshPushSourceActive({ lastIngestAt: NOW - 600001 }, NOW, 600000), false);
});

test('auto mode suppresses only an active source with a matching rootId', () => {
  const root = path.resolve('test-fixtures', 'dsh-root');
  const rootId = deriveDshRootId(root, process.platform);
  const sources = { src1: { rootId, lastIngestAt: NOW - 1000 } };
  assert.equal(shouldPollDshLocalLog(store({ 'providers.dsh.collectionMode': 'auto', 'ingest.dsh.sources': sources, 'ingest.dsh.pushLeaseMs': 600000 }), root, NOW), false);
  assert.equal(shouldPollDshLocalLog(store({ 'providers.dsh.collectionMode': 'auto', 'ingest.dsh.sources': { src2: { rootId: 'root:' + 'f'.repeat(64), lastIngestAt: NOW } }, 'ingest.dsh.pushLeaseMs': 600000 }), root, NOW), true);
});

test('explicit modes override auto behavior', () => {
  const root = '/tmp/any-root';
  assert.equal(shouldPollDshLocalLog(store({ 'providers.dsh.collectionMode': 'push' }), root, NOW), false);
  assert.equal(shouldPollDshLocalLog(store({ 'providers.dsh.collectionMode': 'localLog' }), root, NOW), true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/dsh-collection-mode.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```js
// dsh 采集模式与 localLog 抑制判断。source 活跃状态由 ingest apply 写入 store。
const path = require('node:path');
const crypto = require('node:crypto');

const MODES = new Set(['auto', 'localLog', 'push']);
const DEFAULT_PUSH_LEASE_MS = 600000;
const MIN_PUSH_LEASE_MS = 180000;

function normalizeDshCollectionMode(value) {
  return MODES.has(value) ? value : 'auto';
}

function canonicalRootPath(rootPath, platform) {
  const abs = path.resolve(String(rootPath || ''));
  if (platform === 'win32') return abs.replace(/\\/g, '/').toLowerCase();
  return abs;
}

function deriveDshRootId(rootPath, platform = process.platform) {
  return 'root:' + crypto.createHash('sha256')
    .update(canonicalRootPath(rootPath, platform), 'utf8')
    .digest('hex');
}

function normalizePushLeaseMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= MIN_PUSH_LEASE_MS ? n : DEFAULT_PUSH_LEASE_MS;
}

function isDshPushSourceActive(source, nowMs, pushLeaseMs) {
  const last = Number(source && source.lastIngestAt);
  const lease = normalizePushLeaseMs(pushLeaseMs);
  return Number.isFinite(last) && nowMs - last < lease;
}

function shouldPollDshLocalLog(store, rootPath, nowMs = Date.now()) {
  const mode = normalizeDshCollectionMode(store.get('providers.dsh.collectionMode'));
  if (mode === 'localLog') return true;
  if (mode === 'push') return false;
  const rootId = deriveDshRootId(rootPath, process.platform);
  const sources = store.get('ingest.dsh.sources') || {};
  const lease = normalizePushLeaseMs(store.get('ingest.dsh.pushLeaseMs'));
  return !Object.keys(sources).some((sourceId) =>
    sources[sourceId] && sources[sourceId].rootId === rootId && isDshPushSourceActive(sources[sourceId], nowMs, lease));
}

module.exports = {
  normalizeDshCollectionMode,
  deriveDshRootId,
  normalizePushLeaseMs,
  isDshPushSourceActive,
  shouldPollDshLocalLog
};
```

修改 `src/main/providers/dsh/index.js`：

```js
const { shouldPollDshLocalLog } = require('../core/dsh-collection-mode');
...
  shouldPollLocalLog(ctx) {
    return shouldPollDshLocalLog(ctx && ctx.store, this.localLogRoot(ctx));
  },
```

修改 `src/main/core/scheduler.js` 的 `pollLocalLog`，完整替换为：

```js
  async function pollLocalLog(provider) {
    try {
      const ctx = ctxFor(provider);
      if (provider.id === 'dsh' && typeof provider.shouldPollLocalLog === 'function'
          && !provider.shouldPollLocalLog(ctx)) {
        // push 模式/活跃 source:跳过本轮文件扫描,不产生错误状态。
        return;
      }
      // Provider 先把增量合并进 usageDaily,随后按真实新增记录决定是否刷新界面。
      // Codex 经由运行时 FIFO 协调器串行化所有写操作;其它 provider 直接读取。
      // dsh 的 readLocalLog 接受 opts.diagnostics(行解析/截断尾行等计数);
      // 其余 provider 保持原调用形态不变。
      const diagnostics = {};
      const batch = (provider.id === 'codex' && codexUsageRuntime)
        ? await codexUsageRuntime.runIncremental((scanOptions) =>
          provider.readLocalLog(ctx, scanOptions)
        )
        : (provider.id === 'dsh'
            ? await provider.readLocalLog(ctx, { diagnostics })
            : await provider.readLocalLog(ctx));
      const records = Array.isArray(batch) ? batch : batch.records;
      const changed = Array.isArray(records) && records.length > 0;
      const recovered = recordChannelRecovery(provider, 'localLog', false);
      if (changed || recovered) touch(provider.id);
      notifyUsageObservation(provider, 'localLog');
      const diagnosticKeys = Object.keys(diagnostics).filter((key) => diagnostics[key] > 0);
      if (diagnosticKeys.length) {
        console.warn('[scheduler] localLog diagnostics for ' + provider.id + ': '
          + diagnosticKeys.map((key) => key + '=' + diagnostics[key]).join(', '));
      }
    } catch (error) {
      recordFailure(provider, 'localLog', error);
      notifyUsageUnavailable(provider, 'localLog');
    }
  }
```

- [ ] **Step 4: 更新 scheduler 测试并运行**

在 `test/dsh-provider-scheduler.test.js` 追加：

```js
test('auto mode skips localLog while a matching root source is active', async () => {
  const { deriveDshRootId } = require('../src/main/core/dsh-collection-mode');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skip-'));
  const store = makeStore({
    usageDaily: {}, 'providers.dsh.telemetryRoot': root, 'providers.dsh.collectionMode': 'auto',
    'ingest.dsh.sources': { src1: { rootId: deriveDshRootId(root, process.platform), lastIngestAt: Date.now() } },
    'ingest.dsh.pushLeaseMs': 600000, data: { historyDays: 30 }
  });
  fs.writeFileSync(path.join(root, 'usage-2026-08-14.jsonl'), JSON.stringify({ v: 1, time: Date.UTC(2026, 7, 14, 2, 0, 0), sessionId: 's', inputTokens: 1, outputTokens: 1 }) + '\n');
  const scheduler = startScheduler({ registry: makeRegistry([dshProvider]), store, broadcast() {}, intervals: false });
  try {
    await scheduler.poll('dsh', 'localLog');
    assert.equal(store.get('usageDaily')['dsh:2026-08-14'], undefined, 'suppressed root must not be scanned');
  } finally { scheduler.stop(); }
});
```

Run: `node --test test/dsh-collection-mode.test.js test/dsh-provider-scheduler.test.js`
Expected: PASS。

- [ ] **Step 5: 全量测试并提交**

Run: `npm test`，然后：

```bash
git add src/main/core/dsh-collection-mode.js src/main/providers/dsh/index.js src/main/core/scheduler.js test/dsh-collection-mode.test.js test/dsh-provider-scheduler.test.js
git commit -m "feat: suppress DSH localLog polling for active push sources"
```

---

### Task 9: 展示层合并本地 + push 聚合

**Files:**
- Modify: `src/main/core/dsh-dashboard.js`
- Modify: `src/main/ipc.js`
- Modify: `src/main/core/token-speed-runtime.js`
- Modify: `src/main/mcp/index.js`
- Test: `test/dsh-dashboard.test.js`、`test/dsh-dashboard-ipc.test.js`、`test/dsh-token-speed.test.js`、`test/mcp-tools.test.js`

**Interfaces:**
- Consumes: Task 2 的 `mergeDshKeys` / `mergeDshCosts` / `effectiveUsageDaily` / `effectiveDshDayTotal`。
- Produces: 不变的外部签名（`buildDshDashboard` 增加可选 push 参数；IPC/MCP 响应 shape 不变）。

- [ ] **Step 1: 修改 `dsh-dashboard.js`**

```js
const { mergeDshKeys, mergeDshCosts } = require('./dsh-usage-merge');

function buildDshDashboard(usageDaily, usageDailyCost, usageDailyPush = {}, usageDailyCostPush = {}) {
  const tokenDaily = dshDailyList(mergeDshKeys(usageDaily, usageDailyPush), (v) => Number(v && v.total));
  const costDaily = dshDailyList(mergeDshCosts(usageDailyCost, usageDailyCostPush), (v) => Number(v));
  let token = 0;
  let cost = 0;
  tokenDaily.forEach((d) => { token += d.total; });
  costDaily.forEach((d) => { cost += d.total; });
  return {
    tokenDaily,
    costDaily,
    aggregate: { token, cost }
  };
}
```

- [ ] **Step 2: 修改 `ipc.js`**

```js
const {
  PUSH_USAGE_KEY, PUSH_COST_KEY,
  effectiveUsageDaily, mergeDshKeys, mergeDshCosts
} = require('./core/dsh-usage-merge');
// get:dashboard dsh 分支:
const stats = buildDshDashboard(
  deps.store.get('usageDaily') || {},
  deps.store.get('usageDailyCost') || {},
  deps.store.get(PUSH_USAGE_KEY) || {},
  deps.store.get(PUSH_COST_KEY) || {}
);
// get:heatmap:
const usageDaily = effectiveUsageDaily(deps.store);
```

- [ ] **Step 3: 修改 `token-speed-runtime.js`**

```js
const { effectiveDshDayTotal } = require('./dsh-usage-merge');
function readObservation(store, providerId, at) {
  const dayKey = localDayStr(at);
  const totalTokens = providerId === 'dsh'
    ? effectiveDshDayTotal(store, dayKey)
    : (() => { const daily = store.get('usageDaily') || {}; const row = daily[providerId + ':' + dayKey]; return Number(row && row.total) || 0; })();
  return { providerId, dayKey, totalTokens, observedAt: at };
}
```

- [ ] **Step 4: 修改 `mcp/index.js`**

```js
const { effectiveUsageDaily } = require('../core/dsh-usage-merge');
// buildToolHandlers 中:
getUsageDaily: () => effectiveUsageDaily(store)
```

- [ ] **Step 5: 补测试**

`test/dsh-dashboard.test.js` 增加：

```js
test('buildDshDashboard merges push aggregates into the dsh curve totals', () => {
  const local = { 'dsh:2026-08-14': { input: 10, cached: 0, output: 20, total: 30 } };
  const push = { 'dsh:2026-08-14': { input: 5, cached: 0, output: 10, total: 15 } };
  const d = buildDshDashboard(local, {}, push, {});
  assert.equal(d.tokenDaily[0].total, 45);
});
```

`test/dsh-token-speed.test.js` 增加：

```js
test('readObservation for dsh includes the push aggregate', () => {
  const store = { get(k) {
    if (k === 'usageDaily') return { 'dsh:2026-08-14': { total: 30 } };
    if (k === 'usageDailyPush') return { 'dsh:2026-08-14': { total: 15 } };
    return undefined;
  } };
  assert.equal(readObservation(store, 'dsh', Date.UTC(2026, 7, 14, 2, 0, 0)).totalTokens, 45);
});
```

- [ ] **Step 6: 全量测试并提交**

Run: `npm test`，然后：

```bash
git add src/main/core/dsh-dashboard.js src/main/ipc.js src/main/core/token-speed-runtime.js src/main/mcp/index.js test/dsh-dashboard.test.js test/dsh-token-speed.test.js test/mcp-tools.test.js
git commit -m "feat: merge DSH push aggregates into dashboard, heatmap, token speed and MCP"
```

---

### Task 10: 设置、安全、重置、启动清理

**Files:**
- Modify: `src/main/core/settings-security.js`
- Modify: `src/main/core/settings-write.js`
- Modify: `src/main/core/settings-reset.js`
- Modify: `src/main/core/usage-retention.js`
- Modify: `src/main/bootstrap.js`
- Test: 更新 `test/settings-security.test.js`、`test/settings-reset-codex-data-integrity.test.js`、`test/usage-retention.test.js`

- [ ] **Step 1: 修改 `settings-security.js`**

```js
const WRITABLE_SETTING_KEYS = new Set([
  'layout', 'componentOrder', 'providers.proxyUrl', 'mcp.enabled', 'providers.dsh.collectionMode'
]);
// SECRET_SETTING_PATHS 增加:
  ['ingest', 'dsh', 'token']
```

`sanitizeSettings` 在删除 `usageDaily` / `usageDailyCost` 后追加（electron-store 的 dot 键以嵌套对象存在，`ingest.dsh.*` 是 `ingest: { dsh: { ... } }`）：

```js
  delete clone.usageDailyPush;
  delete clone.usageDailyCostPush;
  if (clone.ingest && clone.ingest.dsh) {
    delete clone.ingest.dsh.batchRegistry;
    delete clone.ingest.dsh.sources;
    delete clone.ingest.dsh.diagnostics;
  }
```

（`clone.ingest.dsh.token` 已被 SECRET_SETTING_PATHS 删除；`enabled` / `listenHost` / 端口等非敏感配置允许进设置页。）

- [ ] **Step 2: 修改 `settings-write.js`**

```js
const { normalizeDshCollectionMode } = require('./dsh-collection-mode');
const { pruneDshPushUsage } = require('./usage-retention');
function normalizeSettingValue(targetKey, value) {
  ...
  if (targetKey === 'providers.dsh.collectionMode') return normalizeDshCollectionMode(value);
  ...
}
// saveSetting 中 data.historyDays 分支:
  pruneUsageDaily(deps.store);
  pruneDshPushUsage(deps.store);
```

- [ ] **Step 3: 修改 `settings-reset.js`**

在 `RESET_KEEP_KEYS` 数组追加：

```js
  'usageDailyPush',
  'usageDailyCostPush',
  'ingest.dsh.batchRegistry',
  'ingest.dsh.sources',
```

- [ ] **Step 4: 修改 `usage-retention.js` 与 `bootstrap.js`**

`usage-retention.js` 追加（**不要** `require('./dsh-usage-merge')`——该模块反向依赖本文件，会形成循环引用；直接在本文件定义 push 存储键）：

```js
const PUSH_USAGE_KEY = 'usageDailyPush';
const PUSH_COST_KEY = 'usageDailyCostPush';

function pruneDshPushUsage(store, nowMs) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('pruneDshPushUsage requires a store with get/set methods');
  }
  const historyDays = normalizeHistoryDays(store.get('data.historyDays'));
  if (!historyDays) return 0;
  let removed = 0;
  [PUSH_USAGE_KEY, PUSH_COST_KEY].forEach((key) => {
    const current = store.get(key) || {};
    const filtered = filterUsageDaily(current, historyDays, nowMs);
    const n = Math.max(0, Object.keys(current).length - Object.keys(filtered).length);
    if (n > 0) store.set(key, filtered);
    removed += n;
  });
  return removed;
}

module.exports = { ..., pruneDshPushUsage };
```

`bootstrap.js` 在现有 `pruneUsageDaily(store)` 后追加：

```js
  pruneDshPushUsage(store);
```

- [ ] **Step 5: 更新测试并全量提交**

`test/settings-security.test.js` 增加：

```js
test('collectionMode is writable but ingest token remains protected', () => {
  assert.equal(isWritableSettingKey('providers.dsh.collectionMode'), true);
  assert.equal(isWritableSettingKey('ingest.dsh.token'), false);
});
```

`test/usage-retention.test.js` 增加 push 剪枝用例（构造含过期 `usageDailyPush` / `usageDailyCostPush` 的 store，调用 `pruneDshPushUsage` 后断言只剩保留窗口内键）。

Run: `npm test`，然后：

```bash
git add src/main/core/settings-security.js src/main/core/settings-write.js src/main/core/settings-reset.js src/main/core/usage-retention.js src/main/bootstrap.js test/settings-security.test.js test/usage-retention.test.js
git commit -m "feat: protect DSH ingest credentials and preserve push ledger on reset"
```

---

### Task 11: IPC、preload、设置页 UI 与主进程装配

**Files:**
- Modify: `src/main/ipc.js`
- Modify: `src/main/index.js`
- Modify: `src/preload/preload.js`
- Modify: `src/renderer/js/settings-definitions.js`
- Modify: `src/renderer/js/settings-window.js`
- Test: 更新 `test/mcp-ipc-static.test.js`（改名为 ingest/设置页静态契约的用例可在本任务直接扩展）、`test/settings-window-theme.test.js` 相邻的静态用例

**Interfaces:**
- Consumes: Task 7 runtime `getConnectionInfo` / `rotateToken`。
- Produces: IPC `ingest:getConnectionInfo`、`ingest:rotateToken`；设置页新增 `providers.dsh.collectionMode` 下拉与「DSH 用量接收」连接信息块。

- [ ] **Step 1: 修改 `ipc.js`**

在 MCP IPC 段之后追加：

```js
  ipcMain.handle('ingest:getConnectionInfo', () => {
    const rt = typeof deps.getIngestRuntime === 'function' ? deps.getIngestRuntime() : null;
    return rt ? rt.getConnectionInfo() : { enabled: false, running: false, port: null, url: null, token: null, diagnostics: {} };
  });

  ipcMain.handle('ingest:rotateToken', async () => {
    const rt = typeof deps.getIngestRuntime === 'function' ? deps.getIngestRuntime() : null;
    if (!rt) throw new Error('DSH ingest 服务未初始化');
    await rt.rotateToken();
    return rt.getConnectionInfo();
  });
```

- [ ] **Step 2: 修改 `preload.js`**

`invoke` 白名单追加：

```js
      'ingest:getConnectionInfo',
      'ingest:rotateToken'
```

- [ ] **Step 3: 修改 `index.js` 装配**

顶部：

```js
const { startIngest } = require('./providers/dsh/ingest');
let ingestRuntime = null;
```

`app.whenReady()` 中 `scheduler = codexBootstrap.scheduler;` 之后：

```js
  ingestRuntime = startIngest({
    store,
    scheduler,
    broadcast: (channel, payload) => broadcastToWindows(channel, payload),
    onUsageObservation: (providerId, detail) => {
      if (tokenSpeedRuntime) tokenSpeedRuntime.observeProvider(providerId, detail.observedAt);
    }
  });
  ingestRuntime.start();
```

`setupIPC` deps 追加 `getIngestRuntime: () => ingestRuntime`。

`applySetting` 中在 mcp.enabled 段之后：

```js
  if (key === 'providers.dsh.collectionMode') {
    if (scheduler) scheduler.poll('dsh', 'localLog');
    return;
  }
```

`before-quit` 中：

```js
  if (ingestRuntime) { ingestRuntime.stop(); ingestRuntime = null; }
```

- [ ] **Step 4: 修改设置定义与设置窗口**

`settings-definitions.js` 在 `tokenSpeedDefinitions` 前加入：

```js
var dshCollectionDefinitions = [
  {
    group: '数据', key: 'providers.dsh.collectionMode', type: 'select',
    label: 'DeepSeek Harness 采集模式', default: 'auto',
    options: [
      { value: 'auto', label: '自动(推送时停止文件轮询)' },
      { value: 'localLog', label: '仅本地文件' },
      { value: 'push', label: '仅推送接收' }
    ]
  }
];
```

`tailDefinitions` 在 MCP 项后加入：

```js
  { group: 'DSH 用量接收', key: 'ingest.dsh.serverInfo', type: 'ingestServer', label: '接收连接信息', default: '' }
```

concat 顺序加入 `dshCollectionDefinitions`。

`settings-window.js`：

`render` 的 switch 增加：

```js
      case 'ingestServer':
        return '<div style="display:flex;flex-direction:column;gap:6px;width:100%;">' +
          '<input type="text" class="text-input" id="ingestServerUrl" readonly value="加载中…" autocomplete="off" spellcheck="false">' +
          '<input type="text" class="text-input" id="ingestServerToken" readonly value="" autocomplete="off" spellcheck="false">' +
          '<span id="ingestStatus" role="status" hidden style="font-size:12px;line-height:1.3;"></span>' +
          '<div style="display:flex;gap:6px;">' +
            '<button type="button" class="btn btn-primary" id="ingestCopyBtn" disabled>复制接收地址</button>' +
            '<button type="button" class="btn" id="ingestRotateBtn">重新生成 token</button>' +
          '</div>' +
        '</div>';
```

新增函数（放在 `rotateMcpToken` 之后）：

```js
  function renderIngestConnectionInfo(info) {
    var urlInput = document.getElementById('ingestServerUrl');
    var tokenInput = document.getElementById('ingestServerToken');
    var copyBtn = document.getElementById('ingestCopyBtn');
    var rotateBtn = document.getElementById('ingestRotateBtn');
    var statusEl = document.getElementById('ingestStatus');
    if (!urlInput || !tokenInput) return;
    urlInput.value = info.running ? info.url : (info.enabled ? '启动中/未运行' : '已关闭');
    tokenInput.value = info.token || '';
    if (copyBtn) copyBtn.disabled = !info.running;
    if (rotateBtn) rotateBtn.disabled = !info.enabled;
    if (statusEl) {
      var diag = info.diagnostics || {};
      var parts = [];
      if (diag['batch-conflict']) parts.push('冲突 ' + diag['batch-conflict']);
      if (diag['invalid-row']) parts.push('非法行 ' + diag['invalid-row']);
      if (diag['unauthorized']) parts.push('未授权 ' + diag['unauthorized']);
      if (diag['registry-full']) parts.push('注册表满 ' + diag['registry-full']);
      statusEl.textContent = parts.length ? ('拒绝计数:' + parts.join(' / ')) : '';
      statusEl.hidden = !parts.length;
    }
  }

  function loadIngestConnectionInfo() {
    if (!document.getElementById('ingestServerUrl')) return;
    window.api.invoke('ingest:getConnectionInfo').then(renderIngestConnectionInfo).catch(function () {
      var urlInput = document.getElementById('ingestServerUrl');
      if (urlInput) urlInput.value = '不可用';
    });
  }

  function copyIngestConnectionInfo() {
    var urlInput = document.getElementById('ingestServerUrl');
    var tokenInput = document.getElementById('ingestServerToken');
    var copyBtn = document.getElementById('ingestCopyBtn');
    if (!urlInput || !tokenInput) return;
    navigator.clipboard.writeText(urlInput.value + '\nAuthorization: Bearer ' + tokenInput.value);
    if (copyBtn) {
      copyBtn.textContent = '已复制';
      setTimeout(function () { copyBtn.textContent = '复制接收地址'; }, 1200);
    }
  }

  function rotateIngestToken() {
    var rotateBtn = document.getElementById('ingestRotateBtn');
    if (rotateBtn) rotateBtn.disabled = true;
    window.api.invoke('ingest:rotateToken').then(renderIngestConnectionInfo).catch(function () {}).then(function () {
      if (rotateBtn) rotateBtn.disabled = false;
    });
  }
```

`renderAll` 的 `loadMcpConnectionInfo();` 后加 `loadIngestConnectionInfo();`。`bindEvents` 中 MCP 绑定块后加：

```js
    var ingestCopyBtn = document.getElementById('ingestCopyBtn');
    if (ingestCopyBtn) ingestCopyBtn.addEventListener('click', copyIngestConnectionInfo);
    var ingestRotateBtn = document.getElementById('ingestRotateBtn');
    if (ingestRotateBtn) ingestRotateBtn.addEventListener('click', rotateIngestToken);
```

`buildPanel` 的 `vertical` 判断加入 `d.type === 'ingestServer'`。

- [ ] **Step 5: 更新静态契约测试并全量**

`test/mcp-ipc-static.test.js` 现有断言要求 preload/ipc 出现 MCP 通道；在本任务对应测试文件追加：

```js
test('ingest IPC channels are whitelisted in preload and handled in ipc', () => {
  const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
  assert.match(preload, /'ingest:getConnectionInfo'/);
  assert.match(preload, /'ingest:rotateToken'/);
  assert.match(ipc, /ipcMain\.handle\('ingest:getConnectionInfo'/);
  assert.match(ipc, /ipcMain\.handle\('ingest:rotateToken'/);
});
```

Run: `npm test`，然后：

```bash
git add src/main/ipc.js src/main/index.js src/preload/preload.js src/renderer/js/settings-definitions.js src/renderer/js/settings-window.js test/mcp-ipc-static.test.js
git commit -m "feat: expose DSH collection mode and ingest connection info in settings"
```

---

### Task 12: 端到端验收与诊断可见性收尾

**Files:**
- Test: `test/dsh-ingest-e2e.test.js`
- 若有缺口：修改 `src/main/providers/dsh/ingest/index.js` / `src/main/providers/dsh/ingest/server.js`

**Interfaces:**
- Consumes: Task 7/8/9/10/11 全部产物。
- Produces: 验收清单逐条对应的集成测试。

- [ ] **Step 1: 写端到端测试**

`test/dsh-ingest-e2e.test.js`（用临时端口启动 runtime，真实 HTTP POST）：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { startIngest } = require('../src/main/providers/dsh/ingest');
const { REGISTRY_KEY } = require('../src/main/providers/dsh/ingest/registry');

function post(port, token, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/v1/dsh/usage', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}
function makeStore(seed = {}) {
  const data = JSON.parse(JSON.stringify(seed));
  return {
    get(key) { return key.split('.').reduce((v, p) => (v == null ? undefined : v[p]), data); },
    set(key, value) {
      if (typeof key === 'object' && key !== null) { Object.keys(key).forEach((k) => this.set(k, key[k])); return; }
      const parts = key.split('.'); let cur = data;
      while (parts.length > 1) { const p = parts.shift(); if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {}; cur = cur[p]; }
      cur[parts[0]] = value;
    }
  };
}
const TS = Date.UTC(2026, 7, 14, 2, 0, 0);
const ROOT = 'root:' + 'a'.repeat(64);
const BATCH = 'sha256:' + 'b'.repeat(64);
const rows = [{ v: 1, time: TS, sessionId: 's1', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }];

test('end-to-end: POST lands in push ledger, retry is idempotent, heartbeat renews lease', async (t) => {
  const store = makeStore({ usageDaily: { 'dsh:2026-08-13': { input: 1, cached: 0, output: 1, total: 2 } }, usageDailyCost: {}, usageDailyPush: {}, usageDailyCostPush: {}, 'data.historyDays': 30 });
  const rt = startIngest({ store, scheduler: { runExclusive(id, ch, fn) { return fn(); }, getSnapshot() { return []; } }, now: () => TS });
  await rt.start();
  t.after(() => rt.stop());
  const info = rt.getConnectionInfo();
  const first = await post(info.port, info.token, { sourceId: 'src-1', rootId: ROOT, batchId: BATCH, sentAt: TS, rows });
  assert.deepEqual(first.body, { ok: true, accepted: 1, duplicates: 0 });
  const second = await post(info.port, info.token, { sourceId: 'src-1', rootId: ROOT, batchId: BATCH, sentAt: TS, rows });
  assert.deepEqual(second.body, { ok: true, accepted: 0, duplicates: 1 });
  assert.equal(store.get('usageDailyPush')['dsh:2026-08-14'].total, 300);
  assert.equal(store.get(REGISTRY_KEY)['src-1'][BATCH].rowCount, 1);
  const hb = await post(info.port, info.token, { sourceId: 'src-1', rootId: ROOT, sentAt: TS, heartbeat: true, rows: [] });
  assert.deepEqual(hb.body, { ok: true, heartbeat: true });
  assert.equal(store.get('ingest.dsh.sources')['src-1'].lastIngestAt, TS);
});
```

- [ ] **Step 2: 运行测试**

Run: `node --test test/dsh-ingest-e2e.test.js`
Expected: PASS；若 runtime 缺少 `now` 注入或 `basePort` 注入，按 Task 7 的 runtime 签名补齐（`now` 传入 `createIngestApply`）。

- [ ] **Step 3: 对照 spec 验收清单逐条核对**

执行前打开 spec 第 10 节，逐条确认：
- 合法 batch 原子写入、重复幂等、409、400/401/413/429/503、映射一致、auto 抑制与租约恢复、collectionMode 三态、手动重扫不删 push、重启后 source 状态恢复（用 `ingest.dsh.sources` 预置后调用 `shouldPollDshLocalLog`）、实时广播、token 独立轮换、rootId 派生一致。
- 缺哪条就在对应模块补测试/实现，不得在无测试情况下改主逻辑。

- [ ] **Step 4: 全量测试并提交**

Run: `npm test`，然后：

```bash
git add test/dsh-ingest-e2e.test.js
git commit -m "test: verify DSH ingest end-to-end acceptance criteria"
```

---

## Self-Review Notes（已执行）

- Spec 覆盖：spec 第 4–10 节的每一项均映射到 Task 1–12；heartbeat、`rootId`、`collectionMode`、push 分仓、注册表原子提交、设置重置保留、限流、Host 白名单均有对应任务。
- 无 TBD/TODO；所有代码块为可直接落盘的具体实现。
- 类型一致性：`PUSH_USAGE_KEY` / `PUSH_COST_KEY` / `REGISTRY_KEY` / `SOURCES_KEY` / `INGEST_TOKEN_KEY` 在各任务引用一致；`commitDshPushRecords` 的 `extraWrites` 在 Task 3 定义、Task 6 消费；`shouldPollLocalLog(ctx)` 在 Task 8 定义、scheduler 消费。
- 待执行时注意：Task 7 的 runtime 需要支持 `options.basePort` 与 `options.now` 注入以便测试（已在对应步骤写出）。
