# 多 Provider 用量监控 + React 重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DeepSeek Monitor 重构为多 Provider(DeepSeek/Codex/Kimi)用量监控桌面应用:渲染层迁移 React+Vite,主进程数据层改为 Provider 适配器架构,新增订阅制额度监控(5h/周窗口+重置时间)与 GitHub 风格 Token 活动热力图。

**Architecture:** 主进程引入 `providers/` 适配器层,每个 provider 实现统一接口,五条采集通道(webSession / officialApi / accountQuota / localLog / proxy)按 provider 声明式启用;所有原始响应归一化为 `UsageRecord` / `QuotaState` 两个领域模型后经 IPC 推送。渲染层用 React+Vite 重写,组件按 capability 驱动;布局策略层(layout-policy 纯函数)原样平移。

**Tech Stack:** Electron 40 / React 18 / Vite 5 / ECharts 5(本地打包,弃用 CDN)/ gridstack 12 / node:test(数据层)+ vitest(渲染层 hooks,可选)

## Global Constraints

- 平台:Windows 优先;`chatgpt.com` 必须支持配置 HTTP 代理(用户本机为 `http://127.0.0.1:7890`),kimi/deepseek 直连。
- **零改动原则**:不得要求用户修改 codex CLI / kimi CLI 的任何配置;只读复用其本地凭证(`~/.codex/auth.json`、`~/.kimi-code/credentials/kimi-code.json`)。
- 凭证安全:token 永不写入日志、永不通过 IPC 发给渲染进程;渲染层只能拿到用量/额度数据。
- 现有窗口行为不变:`window:set-bounds` / `resize:end` / `is-window-resizing` 的 B+ 缩放机制原样保留(参见 `src/renderer/js/app.js` 与 `src/main/index.js:500-510`)。
- 订阅制口径:额度端点只给"已用百分比+重置时间",不给绝对 token 数;非本机绝对 token 消耗不可得,UI 不得虚构。
- 依赖限制:不引入 node-gyp 原生模块;渲染层状态管理只用 React 自带(useSyncExternalStore),不装 redux/zustand。
- 测试基线:改动全程 `node --test` 保持绿(当前 84 个);数据层新增纯函数必须有单测。

---

## 已验证的事实(实现依据,勿再猜测)

- Codex 额度:`GET https://chatgpt.com/backend-api/wham/usage`,头 `Authorization: Bearer <tokens.access_token>` + `ChatGPT-Account-Id: <tokens.account_id>` + `User-Agent: codex_cli_rs/0.46.0`。凭证在 `~/.codex/auth.json`(`tokens.access_token/account_id/refresh_token`,`last_refresh`)。响应含 `rate_limit.primary_window{used_percent,limit_window_seconds,reset_after_seconds,reset_at}`(可能为周窗口 604800s,5h 窗口可能为 null)、`additional_rate_limits[]`、`plan_type`。**注意:`used_percent` 字段语义经用户核实为"剩余百分比"方向需实测校准,实现时以 CLI 显示为准做一次断言。**
- Kimi 额度:`GET https://api.kimi.com/coding/v1/usages`,头 `Authorization: Bearer <access_token>`。凭证在 `~/.kimi-code/credentials/kimi-code.json`(`access_token/refresh_token/expires_at`,**expires_at 很快过期,必须实现 refresh**)。响应:`usage{limit,used,remaining,resetTime}`(周窗口)+ `limits[0].detail{...}`(300 分钟 = 5h 窗口)。无月度端点(已探 8 个路径全 404)。
- Codex 本地日志:`~/.codex/sessions/**/rollout-*.jsonl`,行格式 `{"timestamp","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{...},"last_token_usage":{"input_tokens","cached_input_tokens","output_tokens","reasoning_output_tokens","total_tokens"}},"rate_limits":{...}}}`。按 `last_token_usage` 逐条累加。
- Kimi 本地日志:`~/.kimi-code/sessions/**/wire.jsonl`,行格式 `{"type":"usage.record","model","usage":{"inputOther","output","inputCacheRead","inputCacheCreation"},"usageScope":"turn","time":<epoch_ms>}`。
- 刷新窗口:Kimi 周额度"以订阅日为起点每 7 天刷新";Codex 5h 为滚动窗口(非定点清零),`reset_at` 由端点给出。

---

### Task 0: 凭证刷新 Spike(调研,不交付功能)

**Files:**
- Create: `scripts/spike-refresh.js`(一次性脚本,不进产品代码)

**Interfaces:**
- Produces: 两个确切结论写入本文件顶部"已验证的事实"区:① Codex `refresh_token` 的刷新端点与 client_id;② Kimi `refresh_token` 的刷新端点。

- [ ] **Step 1: Codex 刷新验证**

在 `scripts/spike-refresh.js` 中读取 `~/.codex/auth.json`,尝试:

```js
// 候选 A(codex CLI 源码中的公开 client_id,执行时从本机 codex 安装中 grep 确认):
//   在 ~/.codex 与 codex CLI 安装目录全局搜索 "client_id" 与 "auth.openai.com"
POST https://auth.openai.com/oauth/token
Content-Type: application/json
{ "client_id": "<从 codex CLI 提取>", "grant_type": "refresh_token", "refresh_token": "<tokens.refresh_token>" }
```

预期:200 返回新 `access_token`(打印 status 与前 8 位,不打印全 token)。若 401/400,降级策略:**每次轮询前重读 auth.json**(CLI 活跃时会自行刷新并回写),并在 provider 状态里标记 `authExpired` 引导用户运行一次 `codex`。

- [ ] **Step 2: Kimi 刷新验证**

尝试(候选端点,按返回调整):

```js
POST https://api.kimi.com/coding/v1/oauth/token   // 候选,若 404 试 /auth/token、/oauth/token
{ "grant_type": "refresh_token", "refresh_token": "<refresh_token>" }
```

若全部 404:在 `~/.kimi-code/bin` 的 CLI 可执行文件中 `grep -oE 'https://[a-z0-9./-]*(oauth|token)[a-z0-9./-]*'` 找真实端点。预期拿到 200 + 新 token;找不到则降级为"重读 credentials 文件 + authExpired 引导"。

- [ ] **Step 3: 结论固化**

把两个端点(或降级策略)写回本计划"已验证的事实"区,并把脚本删除或移入 `scripts/` 保留。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-02-multi-provider-react-refactor.md scripts/spike-refresh.js
git commit -m "docs: verify oauth refresh endpoints for codex/kimi quota channels"
```

---

### Task 1: Vite+React 工程骨架(不动旧渲染层)

**Files:**
- Create: `renderer/package.json`、`renderer/vite.config.js`、`renderer/index.html`、`renderer/src/main.jsx`、`renderer/src/App.jsx`
- Modify: `package.json`(加 scripts)、`src/main/index.js:90`(加载目标切换逻辑)

**Interfaces:**
- Produces: `npm run build:renderer` 输出 `renderer/dist/`;`window.__APP_VERSION__` 无;主进程 `loadRenderer(win)` 函数(优先 dist,回退旧 `src/renderer/index.html`,供灰度)。

- [ ] **Step 1: 骨架文件**

`renderer/package.json`:

```json
{
  "name": "deepseek-monitor-renderer",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "echarts": "^5.5.0",
    "gridstack": "^12.3.3"
  },
  "devDependencies": { "vite": "^5.4.0", "@vitejs/plugin-react": "^4.3.0" }
}
```

`renderer/vite.config.js`:

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: './',                       // Electron file:// 加载必须相对路径
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5199 }
});
```

`renderer/src/main.jsx`:

```jsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
createRoot(document.getElementById('root')).render(<App />);
```

`renderer/src/App.jsx` 先渲染静态 "DeepSeek Monitor v2" 占位 + 8 个 `.resize-handle`(class 与旧版完全一致:`resize-n/s/e/w/ne/nw/se/sw`,缩放行为零回归)。

`renderer/index.html`:保留旧 `index.html` 的 CSP 但**去掉** `https://cdn.jsdelivr.net`(echarts 改本地打包);`<div id="root">` + `<script type="module" src="/src/main.jsx">`。

- [ ] **Step 2: 主进程加载切换**

`src/main/index.js` 顶部新增:

```js
const fs = require('fs');
function loadRenderer(win) {
  const dist = path.join(__dirname, '..', '..', 'renderer', 'dist', 'index.html');
  if (fs.existsSync(dist)) win.loadFile(dist);
  else win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}
```

`createMainWindow` 中 `mainWindow.loadFile(...)` 改为 `loadRenderer(mainWindow)`。

- [ ] **Step 3: 根 package.json 加脚本**

```json
"build:renderer": "npm --prefix renderer run build",
"dev:renderer": "npm --prefix renderer run dev"
```

- [ ] **Step 4: 验证**

Run: `cd renderer && npm install && npm run build && cd .. && node --test && npm start`
Expected: 构建成功;84 测试全绿;应用启动显示 React 占位页(标题栏/状态栏可以还没有)。

- [ ] **Step 5: Commit**

```bash
git add renderer package.json src/main/index.js
git commit -m "feat: vite+react renderer scaffold with legacy fallback"
```

---

### Task 2: Provider 适配器层 + DeepSeek 迁移(行为不变)

**Files:**
- Create: `src/main/providers/types.js`、`src/main/providers/registry.js`、`src/main/providers/deepseek/index.js`、`src/main/providers/deepseek/session.js`、`src/main/providers/deepseek/usage.js`、`src/main/providers/deepseek/balance.js`、`src/main/providers/deepseek/proxy.js`
- Test: `test/providers-deepseek.test.js`、`test/providers-registry.test.js`
- Modify: 无(旧 `fetcher.js/balance.js/proxy.js` 暂留,Task 3 接线后由 Task 12 删除;`deepseek/proxy.js` 为旧 `src/main/proxy.js` 原样搬迁,类名 `ProxyServer` 与构造签名不变)

**Interfaces:**
- Produces(后续所有任务依赖):

```js
// types.js —— 纯 JSDoc 注释 + 工厂函数,无运行时代码
// UsageRecord:  { provider, date:'YYYY-MM-DD', model, inputTokens, outputTokens, cachedTokens, cost, currency }
// QuotaState:   { provider, billingMode:'prepaid'|'subscription', windows:[{kind:'5h'|'weekly', used, limit, remaining, resetsAt}] | null, balance:{total,granted,toppedUp,currency}|null, planName, billingCycleEnd, fetchedAt }
// ProviderAdapter = {
//   id, displayName,
//   capabilities: { balance, webUsage, quota, localLog, realtimeProxy },
//   authStatus(ctx) -> 'ok'|'expired'|'missing',
//   fetchBalance(ctx) -> QuotaState.balance|null,     // 可选
//   fetchUsage(ctx, {month,year}) -> { dailyData, aggregate }, // 可选,保持 DeepSeek 现有返回形状
//   fetchQuota(ctx) -> QuotaState|null,               // 可选
//   readLocalLog(ctx, {sinceMs}) -> UsageRecord[]     // 可选
// }
// ctx = { store, httpGet(url,headers,proxyUrl), getProxyUrl(), logger }

// registry.js
register(adapter); list() -> adapters[]; get(id) -> adapter;
```

- [ ] **Step 1: 写失败测试 —— deepseek adapter 与旧解析器输出等价**

`test/providers-deepseek.test.js` 复用 `test/fetcher-usage.test.js` 的 fixture 思路:同一 raw 响应分别过旧 `src/main/fetcher.js` 的导出与新 adapter 的 `fetchUsage`,断言 `aggregate.totalCost/totalTokens/cacheRate/models` 完全一致。

- [ ] **Step 2: 跑测试确认失败**(模块不存在)

- [ ] **Step 3: 实现**

`deepseek/usage.js`:把 `src/main/fetcher.js` 的 `httpGet/parseCostData/parseTokenData/fetchUsageWithFallback` 原样搬入(host 从常量改为 `this.host`,便于测试);`deepseek/balance.js` 搬 `balance.js`;`deepseek/session.js` 搬 `index.js:146-190` 的会话窗口逻辑为 `captureSession(ctx) -> token`(BrowserWindow 嗅探逻辑不变,仍匹配 `/api/v0/usage/` + 非 sk- Bearer);`deepseek/index.js` 组装:

```js
module.exports = {
  id: 'deepseek', displayName: 'DeepSeek',
  capabilities: { balance: true, webUsage: true, quota: false, localLog: false, realtimeProxy: true },
  authStatus(ctx) { return ctx.store.get('providers.deepseek.sessionToken') ? 'ok' : 'missing'; },
  fetchBalance, fetchUsage, /* quota: 无 */ /* readLocalLog: 无 */
};
```

- [ ] **Step 4: 测试转绿** + `node --test` 全套回归

- [ ] **Step 5: Commit** `refactor: extract deepseek provider adapter (no behavior change)`

---

### Task 3: 主进程接线——调度器、IPC、存储命名空间化

**Files:**
- Create: `src/main/core/scheduler.js`、`src/main/core/http.js`、`src/main/ipc.js`
- Modify: `src/main/index.js`(瘦身:只留 app 生命周期、窗口创建、托盘;IPC 全部移到 `ipc.js`)、`src/main/store.js`(键迁移)
- Test: `test/scheduler.test.js`、`test/settings-sync-static.test.js`(更新)

**Interfaces:**
- Consumes: Task 2 的 `registry`/`ProviderAdapter`
- Produces:

```js
// scheduler.js
startScheduler({ registry, store, broadcast }) // 每 provider 独立定时器:usage 10s、quota 60s、balance 60s;401→authStatus='expired'→broadcast
// IPC(渲染层契约,Task 8 消费):
// invoke 'get:providers' -> [{ id, displayName, capabilities, authStatus, quota, lastError }]
// invoke 'get:dashboard', providerId -> 该 provider 的 usage/balance 负载(保持 DeepSeek 现有字段)
// on 'providers:changed' -> 全量 providers 快照(任何 provider 数据/状态更新时推送)
// store 迁移: 'sessionToken'→'providers.deepseek.sessionToken','apiKey'→'providers.deepseek.apiKey'(启动时一次性 migrate,含旧值保留校验)
```

- [ ] **Step 1: 失败测试 —— 存储迁移**(旧键写入 → migrate 后新键可读、旧键删除)
- [ ] **Step 2: 失败测试 —— scheduler**(假 adapter:quota 抛 401 → broadcast 收到 authStatus='expired';成功 → broadcast 收到 quota)
- [ ] **Step 3: 实现三个文件 + index.js 瘦身**(resize IPC、`window:set-bounds`、缩放状态机原样搬入 `ipc.js`,逻辑零改动)
- [ ] **Step 4: 全测试绿 + `npm start` 手工验证 DeepSeek 面板与旧版一致**
- [ ] **Step 5: Commit** `refactor: provider scheduler, namespaced store, ipc module`

---

### Task 4: Codex provider(accountQuota 通道)

**Files:**
- Create: `src/main/providers/codex/index.js`、`src/main/providers/codex/auth.js`、`src/main/providers/codex/quota.js`
- Test: `test/providers-codex.test.js`

**Interfaces:**
- Consumes: `ctx.httpGet(url, headers, proxyUrl)`(Task 3)、Task 0 的刷新结论
- Produces:

```js
// auth.js
readAuth() -> { accessToken, accountId, refreshToken, lastRefresh } | null   // 读 ~/.codex/auth.json,每次调用重读文件
ensureFresh(ctx) -> same | null  // 过期则按 Task 0 结论刷新并回写;失败返回 null
// quota.js
fetchQuota(ctx) -> QuotaState // 见下
```

- [ ] **Step 1: 失败测试 —— 响应归一化**

用今日实测响应做 fixture(存 `test/fixtures/codex-wham-usage.json`,token 字段打码):

```js
const quota = normalizeWhamUsage(fixture);
assert.equal(quota.billingMode, 'subscription');
assert.equal(quota.planName, 'pro');
const weekly = quota.windows.find(w => w.kind === 'weekly');
assert.equal(weekly.remaining, 44);            // 语义以用户核实为准:used_percent=44 对应"剩余 44%"
assert.equal(weekly.limit, 100);
assert.ok(weekly.resetsAt > 0);
// windows 换算规则:limit_window_seconds===18000→'5h',604800→'weekly',其他按秒数推断并保留原值
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**(`fetchQuota` 走 `ctx.getProxyUrl()`;`normalizeWhamUsage` 处理 `secondary_window:null` 与 `additional_rate_limits[]` 合并进 windows;`credits.has_credits` 映射进 `balance`)
- [ ] **Step 4: 测试绿;`node scripts/spike-refresh.js` 模式跑一次真实抓取打印归一化结果,与 CLI 显示对照**
- [ ] **Step 5: Commit** `feat: codex provider with account quota channel`

---

### Task 5: Kimi provider(accountQuota 通道)

同 Task 4 结构。文件:`src/main/providers/kimi/{index,auth,quota}.js` + `test/providers-kimi.test.js`。

- [ ] **Step 1: 失败测试 —— 用今日实测响应做 fixture**:

```js
const quota = normalizeKimiUsage(fixture);
assert.equal(quota.billingMode, 'subscription');
const weekly = quota.windows.find(w => w.kind === 'weekly');
assert.deepEqual([weekly.used, weekly.limit, weekly.remaining], [57, 100, 43]);
assert.equal(new Date(weekly.resetsAt).toISOString(), '2026-08-06T18:08:07.095Z');
const fiveH = quota.windows.find(w => w.kind === '5h');
assert.deepEqual([fiveH.used, fiveH.limit, fiveH.remaining], [65, 100, 35]);
// 判定规则:limits[i].window.duration===300 && timeUnit==='TIME_UNIT_MINUTE' → '5h';顶层 usage → 'weekly'
```

- [ ] **Step 2-4:** 实现(auth.js 读 `~/.kimi-code/credentials/kimi-code.json`,**expires_at 临期必须刷新**,刷新端点用 Task 0 结论)、测试绿、真实抓取对照 `/usage`
- [ ] **Step 5: Commit** `feat: kimi provider with account quota channel`

---

### Task 6: localLog 通道(Codex rollout + Kimi wire 解析与聚合)

**Files:**
- Create: `src/main/core/locallog.js`、`src/main/providers/codex/locallog.js`、`src/main/providers/kimi/locallog.js`
- Test: `test/locallog.test.js`、`test/usage-daily.test.js`

**Interfaces:**
- Produces:

```js
// core/locallog.js
scanFiles({ root, match, cursorStore, cursorKey }) // 增量:store 存 { path: { offset, mtimeMs } },只读新增字节
// providers/codex/locallog.js
parseRolloutLine(line) -> { ts, usage:{input,cached,output,reasoning,total} } | null  // 取 payload.info.last_token_usage
// providers/kimi/locallog.js
parseWireLine(line) -> { ts, model, usage:{input:u.inputOther, cached:u.inputCacheRead, output:u.output} } | null
// 聚合输出 store 键 'usageDaily': { '<provider>:<YYYY-MM-DD>': { input, cached, output, total } }
// rollupDaily(records) -> 同上形状(纯函数,可测)
```

- [ ] **Step 1: 失败测试 —— 行解析**(用今日实测两行真实日志做 fixture,断言字段映射;非 JSON/无 usage 行返回 null)
- [ ] **Step 2: 失败测试 —— rollupDaily**(跨两天的 4 条记录 → 两个日键,数值求和正确;本地时区按 `localTodayStr` 同款逻辑)
- [ ] **Step 3: 失败测试 —— 增量游标**(同一文件追加内容后再次扫描,只返回新增行;文件截断/轮换时 offset 回退到 0)
- [ ] **Step 4: 实现 + 测试绿**
- [ ] **Step 5: 真实数据自检**:跑 `rollupDaily` 对本机全量日志,今日 codex 应≈ input 338M/cached 329M/output 0.97M,kimi 今日非缓存输入≈215K、缓存读取≈5.87M、输出≈70K(今日实测锚点)
- [ ] **Step 6: Commit** `feat: local log channels with incremental cursors and daily rollup`

---

### Task 7: 热力图数据 API

**Files:**
- Create: `src/main/core/heatmap.js`
- Modify: `src/main/ipc.js`(注册 invoke)
- Test: `test/heatmap.test.js`

**Interfaces:**
- Consumes: Task 6 的 `usageDaily`
- Produces:

```js
// invoke 'get:heatmap', { provider:'deepseek'|'codex'|'kimi'|'all', year:2026 }
//   -> { days: { 'YYYY-MM-DD': totalTokens }, maxDaily }
// buildHeatmap(usageDailyByProvider, provider, year) -> 同上(纯函数)
// 'all' = 三家按日求和;DeepSeek 的日数据来自其 webUsage dailyData(total 字段)
```

- [ ] **Step 1: 失败测试**(两家各两天 → 'all' 求和;缺 provider 数据时只返回有数据的;maxDaily 正确)
- [ ] **Step 2-4:** 实现、绿、注册 IPC
- [ ] **Step 5: Commit** `feat: heatmap data api`

---

### Task 8: React 壳 + IPC 客户端 + 窗口行为迁移

**Files:**
- Create: `renderer/src/api.js`、`renderer/src/store.js`、`renderer/src/hooks/useProviders.js`、`renderer/src/components/TitleBar.jsx`、`renderer/src/components/StatusBar.jsx`、`renderer/src/components/ResizeHandles.jsx`、`renderer/src/styles.css`
- Test: `test/renderer-static.test.js`(沿用正则静态测试风格)

**Interfaces:**
- Consumes: Task 3 的 IPC 契约、Task 7 的 `get:heatmap`
- Produces:

```js
// api.js —— window.api 的 React 侧封装:getProviders(), getDashboard(id), getHeatmap(arg), onProvidersChanged(cb)
// store.js —— useSyncExternalStore 的极简实现:providers 快照 + dashboardById 缓存
// ResizeHandles.jsx —— 8 个 handle + 完整移植旧 app.js 的 onResizeStart/mousemove/mouseup 逻辑
//   (含 is-window-resizing 类切换、_cssScale、window:set-bounds 即时提交、scheduleRoundedRestore),行为逐行等价
// TitleBar.jsx —— 刷新/设置/布局编辑/最小化/关闭按钮,图标沿用旧 SVG
```

- [ ] **Step 1: 失败静态测试**(断言 `resize:set-bounds` 即时提交、无 `resize:move`、`is-window-resizing` 类逻辑存在——等价于现有 `test/resize-shrink-static.test.js` 对 React 源的重指向)
- [ ] **Step 2: 实现**(缩放逻辑从 `src/renderer/js/app.js:91-257` 逐行翻译为 `useRef`/`useEffect`;CSS 变量与 `is-window-resizing` 覆盖规则原样抄入 `styles.css`)
- [ ] **Step 3: `npm run build:renderer && npm start`,人工验证:拖动四边缩放无 artifacts、最小化/关闭/设置按钮IPC可用**
- [ ] **Step 4: Commit** `feat: react shell with titlebar, statusbar, resize behavior parity`

---

### Task 9: 仪表盘组件迁移(Balance/Fee 卡片/ECharts/gridstack)

**Files:**
- Create: `renderer/src/components/Dashboard.jsx`、`renderer/src/components/FeeCard.jsx`、`renderer/src/components/ChartWidget.jsx`、`renderer/src/hooks/useECharts.js`、`renderer/src/grid/policy.js`
- Test: `test/layout-policy.test.js`(现有纯函数测试**原样通过**,文件迁移不改逻辑)

**Interfaces:**
- Consumes: `api.getDashboard(id)`、Task 8 store
- Produces: `useECharts(ref, optionBuilder, deps)`;`policy.js` = 现有 `src/renderer/js/layout/layout-policy.js` 转 ESM(逐行,不改逻辑);gridstack 经 `useRef` 封装,编辑模式/预设/迁移行为与旧版一致

- [ ] **Step 1: layout-policy 迁移**——先移动文件并把测试 import 路径改到 `renderer/src/grid/policy.js`,跑 `node --test test/layout-policy.test.js` 保持全绿(不允许改断言)
- [ ] **Step 2: 组件实现**(echarts 本地 `import * as echarts from 'echarts'`,弃 CDN;主题/密度自适应逻辑从 `curve-chart.js` 平移)
- [ ] **Step 3: 构建 + 人工对照新旧面板截图(卡片数值、图表形状、布局编辑模式)**
- [ ] **Step 4: Commit** `feat: dashboard widgets on react with gridstack parity`

---

### Task 10: QuotaCard(订阅制额度面板)

**Files:**
- Create: `renderer/src/components/QuotaCard.jsx`、`renderer/src/components/WindowBar.jsx`
- Test: `test/quota-card-static.test.js`

**Interfaces:**
- Consumes: `QuotaState`(Task 2 定义,`windows[].kind/used/limit/remaining/resetsAt`、`billingCycleEnd`、`planName`)
- Produces: `<QuotaCard provider quotaState />`;`<WindowBar kind used limit remaining resetsAt />`

行为规格:
- 每个窗口一条进度条:`已用 used/limit(剩余 remaining)`,进度按 `used/limit` 着色(绿<70%、橙<90%、红≥90%)
- `resetsAt` 显示为倒计时(`3小时12分后重置` / `8月7日 02:08 重置`,<24h 用倒计时,≥24h 用绝对时间),每分钟重渲染
- `billingMode==='subscription'` 时不显示任何金额;`billingCycleEnd`(订阅续费日)单独一行小字
- Codex 无 5h 窗口时只渲染返回了的窗口(`windows` 数组驱动,不写死两条)
- `authStatus==='expired'` 时卡片替换为"登录已过期,点击重新授权"按钮(触发该 provider 的登录流程)

- [ ] **Step 1: 失败静态测试**(断言组件按 windows 数组渲染、subscription 不出现 `¥/$`、倒计时文案函数 `formatReset(resetsAt, now)` 的三个分支)——`formatReset` 提成纯函数放 `renderer/src/lib/format.js`,node 侧可测
- [ ] **Step 2-3: 实现 + 构建人工验证**(与 kimi `/usage`、codex 限额显示对照)
- [ ] **Step 4: Commit** `feat: subscription quota cards with window countdowns`

---

### Task 11: TokenHeatmap(GitHub 风格活动图)

**Files:**
- Create: `renderer/src/components/TokenHeatmap.jsx`、`renderer/src/lib/heatmap.js`
- Test: `test/heatmap-cells.test.js`

**Interfaces:**
- Consumes: `api.getHeatmap({provider,year}) -> { days, maxDaily }`
- Produces:

```js
// lib/heatmap.js(纯函数,node 可测)
buildWeeks(year) -> weeks[53][7]  // GitHub 惯例:每列=一周(周日起),每行=星期几;每格 { date:'YYYY-MM-DD', inYear }
colorLevel(value, maxDaily) -> 0|1|2|3|4  // 0=0,四档按 value/maxDaily 均分
formatToken(n) -> '3.9亿'|'1,234万'|'8,521'  // ≥1e8 用亿(1位小数),≥1e4 用万,否则千分位
// TokenHeatmap.jsx:53 列×7 行 CSS Grid,cell 12px+2px gap,颜色用主题 primary 的 5 档透明度;
// 顶部 Tab:每日|每周|累计(每周=按 ISO 周求和后画 52 列 1 行;累计=从年初累加曲线,用 div 高度条);
// hover tooltip:'7月30日 使用了 3.9亿 个 Token';月份标签行(9月…8月)
```

- [ ] **Step 1: 失败测试**(`buildWeeks(2026)` 首格日期正确;`colorLevel` 边界;`formatToken(390000000)==='3.9亿'`、`formatToken(8521)==='8,521'`)
- [ ] **Step 2-3: 实现 + 构建人工验证**(与本机今日 codex 3.4 亿锚点对照 tooltip)
- [ ] **Step 4: Commit** `feat: token activity heatmap with daily/weekly/cumulative modes`

---

### Task 12: 收尾——旧代码清理 + 打包验证

**Files:**
- Delete: `src/renderer/js/**`、`src/renderer/css/**`、`src/renderer/index.html`、旧 `src/main/fetcher.js`、`src/main/balance.js`、`src/main/proxy.js`(已入 providers)
- Modify: `package.json`(build 脚本链)、`electron-builder.yml`(renderer/dist 进包)、`项目结构.md`

- [ ] **Step 1: 删除旧渲染层与已迁移的主进程文件;`loadRenderer` 移除回退分支(只留 dist)**
- [ ] **Step 2: 静态测试清理**(`test/` 中断言旧文件存在的用例更新;`node --test` 全绿)
- [ ] **Step 3: `npm run build:renderer && npm run build:win`,安装包启动验证三 provider 面板**
- [ ] **Step 4: 更新 `项目结构.md` 与新架构说明(AGENTS.md 如存在同步更新)**
- [ ] **Step 5: Commit** `chore: remove legacy renderer, finalize multi-provider build`

---

## 风险与降级链

- 内部端点变更(wham/usage、coding/v1/usages):`fetchQuota` 解析失败 → provider `lastError`,UI 显示"数据获取失败"并保留上次快照;localLog 通道不受影响,热力图持续可用。
- 凭证过期且刷新失败:`authStatus='expired'` → QuotaCard 显示重新授权入口(DeepSeek 复用现有会话窗口;Codex/Kimi 引导用户运行一次对应 CLI)。
- 非本机绝对 token 数不可得:热力图对 codex/kimi 只反映本机日志,UI 在 provider 选择为 codex/kimi 时标注"仅本机"。
