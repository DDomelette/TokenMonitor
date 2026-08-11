# MCP 只读用量服务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Electron 主进程内嵌一个 stateless Streamable HTTP MCP 服务（`127.0.0.1:3950/mcp` + Bearer token），向 VS Code / Cursor / Codex CLI 提供只读的 Provider 剩余额度与用量查询。

**Architecture:** 新增 `src/main/mcp/` 四模块：`token.js`（凭证生成/轮换）、`projection.js`（快照→脱敏 JSON 纯函数）、`tools.js`（MCP 工具/资源注册）、`server.js`（HTTP + Bearer + Host 校验 + 端口回退）。数据全部来自现有 `scheduler.getSnapshot()/getState()` 与 `store['usageDaily']`，不做额外采集。主进程 `index.js` 在 `startSchedulerRuntime()` 后接线 `startMCP()`。

**Tech Stack:** Electron 40（Node 22）、`@modelcontextprotocol/sdk`（新生产依赖，纯 JS）、CommonJS、`node --test`。

## Global Constraints

- 只监听 `127.0.0.1`，拒绝 `0.0.0.0`；仅接受 Host 为 `127.0.0.1:*` / `localhost:*` 的请求（否则 403）。
- 所有请求必须带 `Authorization: Bearer <token>`，无/错 → 401。
- **Stateless**：每请求新建 `McpServer` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`。
- **只读**：不注册任何写操作工具。
- **不输出 cost/金额**；模型级明细仅 deepseek（`[{model, tokens}]`），codex/kimi 返回空数组 + `note`。
- 额度时间戳一律用 `quotaFetchedAt`，不用全 channel 共享的 `lastFetchedAt`。
- `mcp.token` 是凭证：写入只走 `token.js`；`sanitizeSettings` 必须脱敏；渲染进程只能通过专用 IPC `mcp:getConnectionInfo` 获取。
- `mcp.enabled`（默认 true）加入 `settings-security.js` 的 `WRITABLE_SETTING_KEYS`。
- 对外标识统一 `tokenmonitor`（serverInfo name、Resource URI scheme `tokenmonitor://`）。
- 测试沿用根目录 `node --test`（CJS）；全量基线 487 通过 / 0 失败 / 1 skipped。
- 所有改动在 feature 分支提交，最后走 PR + CI + rebase merge 流程（详见 Task 7）。

---

### Task 1: `src/main/mcp/token.js` — token 生成/持久化/轮换

**Files:**
- Create: `src/main/mcp/token.js`
- Test: `test/mcp-token.test.js`

**Interfaces:**
- Produces:
  - `ensureMcpToken(store) -> string`：store 无 `mcp.token` 时生成 48 位 hex 并写入，返回 token；已有则原样返回
  - `rotateMcpToken(store) -> string`：无条件生成新 token 写入并返回
  - store 为有 `get(key)`/`set(key, value)` 的对象（点路径键，与主进程 store 一致）

- [ ] **Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMcpToken, rotateMcpToken } = require('../src/main/mcp/token');

function makeStore(seed) {
  const data = Object.assign({}, seed);
  return { data, get(k) { return data[k]; }, set(k, v) { data[k] = v; } };
}

test('ensureMcpToken generates and persists a 48-char hex token when missing', () => {
  const store = makeStore({});
  const token = ensureMcpToken(store);
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(store.get('mcp.token'), token);
});

test('ensureMcpToken keeps an existing token', () => {
  const store = makeStore({ 'mcp.token': 'existing-token' });
  assert.equal(ensureMcpToken(store), 'existing-token');
});

test('rotateMcpToken always replaces the stored token', () => {
  const store = makeStore({ 'mcp.token': 'old' });
  const next = rotateMcpToken(store);
  assert.match(next, /^[0-9a-f]{48}$/);
  assert.notEqual(next, 'old');
  assert.equal(store.get('mcp.token'), next);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/mcp-token.test.js`
Expected: FAIL，`Cannot find module '../src/main/mcp/token'`

- [ ] **Step 3: 实现**

```js
// MCP Bearer token:启动时确保存在,支持轮换。凭证只经本模块读写 store。
const crypto = require('node:crypto');

const TOKEN_KEY = 'mcp.token';

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function ensureMcpToken(store) {
  const existing = store.get(TOKEN_KEY);
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const token = generateToken();
  store.set(TOKEN_KEY, token);
  return token;
}

function rotateMcpToken(store) {
  const token = generateToken();
  store.set(TOKEN_KEY, token);
  return token;
}

module.exports = { ensureMcpToken, rotateMcpToken, TOKEN_KEY };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/mcp-token.test.js`
Expected: 3 pass

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/token.js test/mcp-token.test.js
git commit -m "feat(mcp): token 生成/持久化/轮换模块"
```

---

### Task 2: `src/main/mcp/projection.js` — 快照投影纯函数

**Files:**
- Create: `src/main/mcp/projection.js`
- Test: `test/mcp-projection.test.js`

**Interfaces:**
- Consumes: `scheduler.getSnapshot()` 返回的数组元素 `{id, displayName, capabilities, authStatus, quota, quotaFetchedAt, lastFetchedAt, stale}`；`scheduler.getState(id)` 返回的 `{balance}`；`usageDaily` 对象（键 `<provider>:YYYY-MM-DD`，值 codex/kimi 为 `{input,cached,output,total}`、deepseek 多一个 `models:[{model,tokens}]`）
- Produces:
  - `projectProviders(snapshot) -> [{id, displayName, capabilities, authStatus, stale, quotaFetchedAt, lastFetchedAt}]`
  - `projectRemainingUsage(snapshot, getState, provider?) -> [{id, displayName, billingMode, balance, windows, quotaFetchedAt, stale, authStatus}]`（`balance` 为 `null` 或 `{total, granted, toppedUp, currency}`，`windows` 为数组）
  - `projectModelUsage(usageDaily, {provider?, date}) -> [{id, models: [{model, tokens}], note?}]`（codex/kimi 无 models → `models: []` + `note: 'provider 无模型级明细'`）
  - `projectUsageSummary(usageDaily, {provider?, date}) -> [{id, input, output, cached, total}]`
  - 以上函数返回前都过 `assertNoSecrets`，发现 `apiKey|sessionToken|password|authorization` 键（大小写不敏感）即 throw

- [ ] **Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  projectProviders,
  projectRemainingUsage,
  projectModelUsage,
  projectUsageSummary
} = require('../src/main/mcp/projection');

const snapshot = [
  {
    id: 'deepseek', displayName: 'DeepSeek',
    capabilities: { balance: true, webUsage: true, quota: false },
    authStatus: 'ok', quota: null, quotaFetchedAt: null,
    lastFetchedAt: 999, stale: false
  },
  {
    id: 'kimi', displayName: 'Kimi',
    capabilities: { balance: false, webUsage: false, quota: true },
    authStatus: 'expired',
    quota: { planName: 'allegretto', billingMode: 'subscription', windows: [{ kind: 'weekly', name: '本周额度', used: 10, limit: 100, remaining: 90, resetsAt: 1 }] },
    quotaFetchedAt: 1234, lastFetchedAt: 999, stale: true
  }
];
const getState = (id) => (id === 'deepseek'
  ? { balance: { total: 12.5, granted: 2.5, toppedUp: 10, currency: 'CNY' } }
  : { balance: null });

test('projectProviders passes authStatus/stale/quotaFetchedAt through', () => {
  const out = projectProviders(snapshot);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], {
    id: 'kimi', displayName: 'Kimi',
    capabilities: snapshot[1].capabilities,
    authStatus: 'expired', stale: true,
    quotaFetchedAt: 1234, lastFetchedAt: 999
  });
  assert.ok(!('quota' in out[1]), 'quota 明细不属于 list_providers');
});

test('projectRemainingUsage maps balance and windows with quotaFetchedAt', () => {
  const out = projectRemainingUsage(snapshot, getState);
  assert.deepEqual(out[0].balance, { total: 12.5, granted: 2.5, toppedUp: 10, currency: 'CNY' });
  assert.equal(out[0].billingMode, null);
  assert.deepEqual(out[0].windows, []);
  assert.equal(out[1].billingMode, 'subscription');
  assert.equal(out[1].windows.length, 1);
  assert.equal(out[1].quotaFetchedAt, 1234);
  assert.equal(out[1].stale, true);
  const onlyKimi = projectRemainingUsage(snapshot, getState, 'kimi');
  assert.equal(onlyKimi.length, 1);
  assert.equal(onlyKimi[0].id, 'kimi');
});

test('projectModelUsage returns deepseek models and note for others', () => {
  const usageDaily = {
    'deepseek:2026-08-11': { input: 0, cached: 5, output: 0, total: 100, models: [{ model: 'deepseek-v4-pro', tokens: 80 }, { model: 'deepseek-v4-flash', tokens: 20 }] },
    'kimi:2026-08-11': { input: 10, cached: 0, output: 40, total: 50 }
  };
  const out = projectModelUsage(usageDaily, { date: '2026-08-11' });
  const ds = out.find((p) => p.id === 'deepseek');
  assert.deepEqual(ds.models, [{ model: 'deepseek-v4-pro', tokens: 80 }, { model: 'deepseek-v4-flash', tokens: 20 }]);
  const kimi = out.find((p) => p.id === 'kimi');
  assert.deepEqual(kimi.models, []);
  assert.equal(kimi.note, 'provider 无模型级明细');
});

test('projectUsageSummary aggregates per provider for one local day', () => {
  const usageDaily = {
    'deepseek:2026-08-11': { input: 0, cached: 5, output: 0, total: 100 },
    'kimi:2026-08-11': { input: 10, cached: 3, output: 40, total: 50 },
    'kimi:2026-08-10': { input: 1, cached: 0, output: 1, total: 2 }
  };
  const out = projectUsageSummary(usageDaily, { date: '2026-08-11' });
  assert.deepEqual(out.find((p) => p.id === 'kimi'), { id: 'kimi', input: 10, output: 40, cached: 3, total: 50 });
  assert.deepEqual(out.find((p) => p.id === 'deepseek'), { id: 'deepseek', input: 0, output: 0, cached: 5, total: 100 });
  const onlyKimi = projectUsageSummary(usageDaily, { provider: 'kimi', date: '2026-08-10' });
  assert.deepEqual(onlyKimi, [{ id: 'kimi', input: 1, output: 1, cached: 0, total: 2 }]);
});

test('projection output never contains credential keys', () => {
  const poisoned = [{
    id: 'x', displayName: 'X', capabilities: {}, authStatus: 'ok',
    quota: { windows: [], apiKey: 'sk-secret' }, quotaFetchedAt: 1, lastFetchedAt: 1, stale: false
  }];
  assert.throws(() => projectRemainingUsage(poisoned, () => ({ balance: null })), /凭证|apiKey/i);
});

test('empty inputs produce empty arrays, not errors', () => {
  assert.deepEqual(projectProviders([]), []);
  assert.deepEqual(projectRemainingUsage([], getState), []);
  assert.deepEqual(projectModelUsage({}, { date: '2026-08-11' }), []);
  assert.deepEqual(projectUsageSummary(null, { date: '2026-08-11' }), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/mcp-projection.test.js`
Expected: FAIL，`Cannot find module '../src/main/mcp/projection'`

- [ ] **Step 3: 实现**

```js
// 把 scheduler 快照/usageDaily 投影为 MCP 对外安全 JSON(纯函数)。
// 数据源本身无凭证;返回前统一过 assertNoSecrets 兜底。

const SECRET_KEY_PATTERN = /apiKey|sessionToken|password|authorization/i;

function assertNoSecrets(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, path + '[' + i + ']'));
    return value;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach((key) => {
      if (SECRET_KEY_PATTERN.test(key)) {
        throw new Error('projection 输出包含疑似凭证键: ' + path + '.' + key);
      }
      assertNoSecrets(value[key], path + '.' + key);
    });
  }
  return value;
}

function projectProviders(snapshot) {
  const out = (Array.isArray(snapshot) ? snapshot : []).map((p) => ({
    id: p.id,
    displayName: p.displayName,
    capabilities: p.capabilities || {},
    authStatus: p.authStatus || 'ok',
    stale: !!p.stale,
    quotaFetchedAt: p.quotaFetchedAt || null,
    lastFetchedAt: p.lastFetchedAt || null
  }));
  return assertNoSecrets(out, '$');
}

function projectRemainingUsage(snapshot, getState, provider) {
  const list = (Array.isArray(snapshot) ? snapshot : [])
    .filter((p) => !provider || p.id === provider)
    .map((p) => {
      const state = typeof getState === 'function' ? getState(p.id) : null;
      const rawBalance = state && state.balance;
      const quota = p.quota || null;
      return {
        id: p.id,
        displayName: p.displayName,
        billingMode: (quota && quota.billingMode) || null,
        balance: rawBalance ? {
          total: rawBalance.total ?? null,
          granted: rawBalance.granted ?? null,
          toppedUp: rawBalance.toppedUp ?? null,
          currency: rawBalance.currency ?? null
        } : null,
        windows: (quota && Array.isArray(quota.windows)) ? quota.windows : [],
        quotaFetchedAt: p.quotaFetchedAt || null,
        stale: !!p.stale,
        authStatus: p.authStatus || 'ok'
      };
    });
  return assertNoSecrets(list, '$');
}

// 按本地日历日取某日各 provider 的日聚合条目
function dailyEntries(usageDaily, date, provider) {
  const source = usageDaily && typeof usageDaily === 'object' ? usageDaily : {};
  const suffix = ':' + date;
  return Object.keys(source)
    .filter((k) => k.endsWith(suffix))
    .map((k) => ({ id: k.slice(0, k.length - suffix.length), entry: source[k] }))
    .filter((row) => !provider || row.id === provider);
}

function projectModelUsage(usageDaily, options) {
  const opts = options || {};
  const out = dailyEntries(usageDaily, opts.date, opts.provider).map((row) => {
    const models = Array.isArray(row.entry && row.entry.models) ? row.entry.models : [];
    const result = {
      id: row.id,
      models: models.map((m) => ({ model: m.model, tokens: Math.round(Number(m.tokens) || 0) }))
    };
    if (!result.models.length) result.note = 'provider 无模型级明细';
    return result;
  });
  return assertNoSecrets(out, '$');
}

function projectUsageSummary(usageDaily, options) {
  const opts = options || {};
  const out = dailyEntries(usageDaily, opts.date, opts.provider).map((row) => ({
    id: row.id,
    input: Math.round(Number(row.entry && row.entry.input) || 0),
    output: Math.round(Number(row.entry && row.entry.output) || 0),
    cached: Math.round(Number(row.entry && row.entry.cached) || 0),
    total: Math.round(Number(row.entry && row.entry.total) || 0)
  }));
  return assertNoSecrets(out, '$');
}

module.exports = {
  assertNoSecrets,
  projectProviders,
  projectRemainingUsage,
  projectModelUsage,
  projectUsageSummary
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/mcp-projection.test.js`
Expected: 6 pass

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/projection.js test/mcp-projection.test.js
git commit -m "feat(mcp): 快照投影纯函数(脱敏断言)"
```

---

### Task 3: `src/main/mcp/tools.js` — 工具/资源定义与 handler

**Files:**
- Create: `src/main/mcp/tools.js`
- Test: `test/mcp-tools.test.js`

**Interfaces:**
- Consumes: Task 2 的 `projectProviders / projectRemainingUsage / projectModelUsage / projectUsageSummary`；`src/main/core/usage-retention.js` 的 `localDayString(timestamp) -> 'YYYY-MM-DD'`
- Produces:
  - `buildToolHandlers(deps) -> { listProviders(), getRemainingUsage(args), getModelUsage(args), getUsageSummary(args), readQuotaResource() }`，全部 async，返回 projection 结果（对象/数组）
    - `deps = { getSnapshot: () => Array, getState: (id) => Object|null, getUsageDaily: () => Object, now: () => number }`
    - `getModelUsage(args)` / `getUsageSummary(args)`：`args.date` 缺省为 `localDayString(deps.now())`；`args.date` 存在但不匹配 `/^\d{4}-\d{2}-\d{2}$/` 时 throw `new Error('date 必须是 YYYY-MM-DD')`；`args.provider` 存在但不是字符串时 throw
  - `registerMcpTools(mcpServer, handlers)`：向 SDK `McpServer` 注册 4 个 tool + 1 个 resource（`tokenmonitor://quota`），返回值为 `{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }`

- [ ] **Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildToolHandlers } = require('../src/main/mcp/tools');

function makeDeps(overrides) {
  return Object.assign({
    getSnapshot: () => [{
      id: 'kimi', displayName: 'Kimi', capabilities: { quota: true },
      authStatus: 'ok', quota: { billingMode: 'subscription', windows: [] },
      quotaFetchedAt: 42, lastFetchedAt: 41, stale: false
    }],
    getState: () => ({ balance: null }),
    getUsageDaily: () => ({ 'kimi:2026-08-11': { input: 1, cached: 0, output: 2, total: 3 } }),
    now: () => new Date(2026, 7, 11, 12, 0, 0).getTime()
  }, overrides || {});
}

test('list_providers returns projected providers', async () => {
  const h = buildToolHandlers(makeDeps());
  const out = await h.listProviders();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'kimi');
  assert.equal(out[0].quotaFetchedAt, 42);
});

test('get_remaining_usage without provider returns all', async () => {
  const h = buildToolHandlers(makeDeps());
  const out = await h.getRemainingUsage({});
  assert.equal(out.length, 1);
  assert.equal(out[0].billingMode, 'subscription');
});

test('get_usage_summary defaults date to local today from deps.now', async () => {
  const h = buildToolHandlers(makeDeps());
  const out = await h.getUsageSummary({});
  assert.deepEqual(out, [{ id: 'kimi', input: 1, output: 2, cached: 0, total: 3 }]);
});

test('get_model_usage validates date format', async () => {
  const h = buildToolHandlers(makeDeps());
  await assert.rejects(() => h.getModelUsage({ date: '08/11' }), /YYYY-MM-DD/);
  await assert.rejects(() => h.getModelUsage({ provider: 42 }), /provider/);
});

test('readQuotaResource mirrors get_remaining_usage without provider', async () => {
  const h = buildToolHandlers(makeDeps());
  assert.deepEqual(await h.readQuotaResource(), await h.getRemainingUsage({}));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/mcp-tools.test.js`
Expected: FAIL，`Cannot find module '../src/main/mcp/tools'`

- [ ] **Step 3: 实现**

```js
// MCP 工具/资源:全部只读。handler 为纯 async 函数(可单测),
// registerMcpTools 负责把它们包装成 SDK 的 content 返回形状。
const {
  projectProviders,
  projectRemainingUsage,
  projectModelUsage,
  projectUsageSummary
} = require('./projection');
const { localDayString } = require('../core/usage-retention');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function resolveArgs(args) {
  const a = args || {};
  if (a.provider !== undefined && typeof a.provider !== 'string') {
    throw new Error('provider 必须是字符串');
  }
  if (a.date !== undefined && !DATE_PATTERN.test(a.date)) {
    throw new Error('date 必须是 YYYY-MM-DD');
  }
  return a;
}

function buildToolHandlers(deps) {
  const snapshot = () => deps.getSnapshot() || [];
  const usageDaily = () => deps.getUsageDaily() || {};
  return {
    async listProviders() {
      return projectProviders(snapshot());
    },
    async getRemainingUsage(args) {
      const a = resolveArgs(args);
      return projectRemainingUsage(snapshot(), deps.getState, a.provider);
    },
    async getModelUsage(args) {
      const a = resolveArgs(args);
      return projectModelUsage(usageDaily(), {
        provider: a.provider,
        date: a.date || localDayString(deps.now())
      });
    },
    async getUsageSummary(args) {
      const a = resolveArgs(args);
      return projectUsageSummary(usageDaily(), {
        provider: a.provider,
        date: a.date || localDayString(deps.now())
      });
    },
    async readQuotaResource() {
      return projectRemainingUsage(snapshot(), deps.getState);
    }
  };
}

function asJsonContent(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function registerMcpTools(mcpServer, handlers) {
  mcpServer.registerTool(
    'list_providers',
    { description: '列出全部 Provider 及其认证/数据新鲜度状态' },
    async () => asJsonContent(await handlers.listProviders())
  );
  mcpServer.registerTool(
    'get_remaining_usage',
    { description: '各 Provider 剩余用量:余额(预付)或订阅窗口(used/limit/remaining/resetsAt)。参数: provider(可选)' },
    async (args) => asJsonContent(await handlers.getRemainingUsage(args))
  );
  mcpServer.registerTool(
    'get_model_usage',
    { description: '某日模型级已消耗 tokens(仅 deepseek 提供模型级明细)。参数: provider(可选), date(YYYY-MM-DD,缺省今日)' },
    async (args) => asJsonContent(await handlers.getModelUsage(args))
  );
  mcpServer.registerTool(
    'get_usage_summary',
    { description: '今日(或指定日)各 Provider 用量汇总 input/output/cached/total。参数: provider(可选), date(可选)' },
    async (args) => asJsonContent(await handlers.getUsageSummary(args))
  );
  mcpServer.registerResource(
    'quota',
    'tokenmonitor://quota',
    { description: '全部 Provider 额度快照', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(await handlers.readQuotaResource(), null, 2)
      }]
    })
  );
}

module.exports = { buildToolHandlers, registerMcpTools };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/mcp-tools.test.js`
Expected: 5 pass

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/tools.js test/mcp-tools.test.js
git commit -m "feat(mcp): 只读 tools/resource 定义与 handler"
```

---

### Task 4: `src/main/mcp/server.js` — HTTP 服务（stateless + Bearer + Host 校验 + 端口回退）

**Files:**
- Create: `src/main/mcp/server.js`
- Test: `test/mcp-server.test.js`
- Modify: `package.json`（新增依赖）

**Interfaces:**
- Consumes: Task 3 的 `registerMcpTools(mcpServer, handlers)`；`handlers`（`buildToolHandlers` 产物）
- Produces:
  - `startMcpServer({ basePort, maxPort, token, handlers, logger? }) -> Promise<{ port, url, close() }>`
  - `url` 形如 `http://127.0.0.1:3950/mcp`；`close()` 返回 Promise
  - 行为契约：仅 POST `/mcp`；Host 非 `127.0.0.1:*`/`localhost:*` → 403；无/错 Bearer → 401；端口占用 → +1 回退直到 `maxPort`（默认 `basePort + 9`），全占用 → throw

- [ ] **Step 1: 安装依赖**

```bash
npm install @modelcontextprotocol/sdk
```

确认 `package.json` 的 `dependencies` 出现 `@modelcontextprotocol/sdk`（1.x）。

- [ ] **Step 2: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { startMcpServer } = require('../src/main/mcp/server');

const TOKEN = 'test-token-123';
const handlers = {
  async listProviders() { return []; },
  async getRemainingUsage() { return []; },
  async getModelUsage() { return []; },
  async getUsageSummary() { return []; },
  async readQuotaResource() { return []; }
};

function post(port, { token, host, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Host': host || ('127.0.0.1:' + port),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } }
};

test('missing or wrong bearer token gets 401', async (t) => {
  const srv = await startMcpServer({ basePort: 0, token: TOKEN, handlers });
  t.after(() => srv.close());
  assert.equal((await post(srv.port, { body: INIT })).status, 401);
  assert.equal((await post(srv.port, { token: 'wrong', body: INIT })).status, 401);
});

test('non-loopback Host gets 403', async (t) => {
  const srv = await startMcpServer({ basePort: 0, token: TOKEN, handlers });
  t.after(() => srv.close());
  const res = await post(srv.port, { token: TOKEN, host: 'evil.example.com', body: INIT });
  assert.equal(res.status, 403);
});

test('valid token initializes the MCP session and names server tokenmonitor', async (t) => {
  const srv = await startMcpServer({ basePort: 0, token: TOKEN, handlers });
  t.after(() => srv.close());
  const res = await post(srv.port, { token: TOKEN, body: INIT });
  assert.equal(res.status, 200);
  assert.match(res.body, /tokenmonitor/);
});

test('occupied base port falls back to basePort + 1', async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(45950, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const srv = await startMcpServer({ basePort: 45950, maxPort: 45952, token: TOKEN, handlers });
  t.after(() => srv.close());
  assert.equal(srv.port, 45951);
  assert.equal(srv.url, 'http://127.0.0.1:45951/mcp');
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test test/mcp-server.test.js`
Expected: FAIL，`Cannot find module '../src/main/mcp/server'`

- [ ] **Step 4: 实现**

```js
// MCP Streamable HTTP 服务(stateless):仅 loopback + Host 白名单 + Bearer 鉴权。
// 纯 node http,无 express;每请求新建 McpServer + transport。
const http = require('node:http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { registerMcpTools } = require('./tools');

const LOOPBACK_HOST_PATTERN = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function createRequestHandler(token, handlers) {
  return async (req, res) => {
    try {
      if (!LOOPBACK_HOST_PATTERN.test(req.headers.host || '')) {
        send(res, 403, 'Forbidden');
        return;
      }
      if (req.url !== '/mcp' || req.method !== 'POST') {
        send(res, 404, 'Not Found');
        return;
      }
      if (req.headers.authorization !== 'Bearer ' + token) {
        send(res, 401, 'Unauthorized');
        return;
      }
      const body = await readBody(req);
      // stateless:每请求独立 server + transport,无会话状态
      const mcpServer = new McpServer({ name: 'tokenmonitor', version: '1.0.0' });
      registerMcpTools(mcpServer, handlers);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) send(res, 500, 'Internal Server Error');
      else res.end();
    }
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

async function startMcpServer(options) {
  const basePort = options.basePort;
  const maxPort = options.maxPort || (basePort ? basePort + 9 : 0);
  const logger = options.logger || console;
  const handler = createRequestHandler(options.token, options.handlers);

  let lastError = null;
  for (let port = basePort; port <= maxPort; port++) {
    const server = http.createServer(handler);
    try {
      // basePort 为 0 时交给系统分配 ephemeral 端口(测试用)
      await listen(server, port || 0);
      const actual = server.address().port;
      if (actual !== basePort && basePort) {
        logger.log('[mcp] port ' + basePort + ' occupied, fallback to ' + actual);
      }
      return {
        port: actual,
        url: 'http://127.0.0.1:' + actual + '/mcp',
        close: () => new Promise((resolve) => server.close(resolve))
      };
    } catch (e) {
      lastError = e;
      try { server.close(); } catch (_) {}
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw lastError || new Error('no available port');
}

module.exports = { startMcpServer };
```

注意：测试里 `basePort: 0` 时 `maxPort` 计算为 0，循环 `port = 0; port <= 0` 执行一次，`listen(server, 0)` 由系统分配端口——与上面实现一致。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/mcp-server.test.js`
Expected: 4 pass

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/mcp/server.js test/mcp-server.test.js
git commit -m "feat(mcp): stateless Streamable HTTP 服务(鉴权/Host 白名单/端口回退)"
```

---

### Task 5: `src/main/mcp/index.js` + 主进程接线与开关

**Files:**
- Create: `src/main/mcp/index.js`
- Modify: `src/main/index.js`（`startSchedulerRuntime()` 调用后接线、`applySetting` 增加 `mcp.enabled` 分支、`updateTrayMenu` 加复制项）
- Modify: `src/main/core/settings-security.js:29`（白名单 + 脱敏路径）
- Test: `test/mcp-runtime.test.js`、`test/settings-security.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 1 `ensureMcpToken/rotateMcpToken`、Task 3 `buildToolHandlers`、Task 4 `startMcpServer`
- Produces:
  - `startMCP({ store, scheduler, logger? }) -> runtime`
  - `runtime = { start(), stop(), isRunning(), getConnectionInfo(), rotateToken() }`
    - `getConnectionInfo() -> { enabled, running, port, url, token }`（未运行 `port/url` 为 null）
    - `rotateToken()`：轮换 token 并**重启服务**使新 token 生效，返回新 token
  - 主进程 `index.js` 内新模块级变量 `mcpRuntime`；`applySetting('mcp.enabled')` 时按值 `mcpRuntime.start()/stop()`
- 端口：basePort `3950`，回退上限 `3959`

- [ ] **Step 1: 写失败测试（runtime + 白名单/脱敏）**

`test/mcp-runtime.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMCP } = require('../src/main/mcp');

function makeStore(seed) {
  const data = Object.assign({}, seed);
  return { data, get(k) { return data[k]; }, set(k, v) { data[k] = v; } };
}
const fakeScheduler = {
  getSnapshot: () => [],
  getState: () => null
};

test('disabled by setting: start() is a no-op, connection info reports disabled', async () => {
  const rt = startMCP({ store: makeStore({ 'mcp.enabled': false }), scheduler: fakeScheduler });
  await rt.start();
  assert.equal(rt.isRunning(), false);
  const info = rt.getConnectionInfo();
  assert.equal(info.enabled, false);
  assert.equal(info.running, false);
  assert.equal(info.url, null);
});

test('enabled by default: start() listens, token persisted, stop() releases', async () => {
  const store = makeStore({});
  const rt = startMCP({ store, scheduler: fakeScheduler });
  await rt.start();
  assert.equal(rt.isRunning(), true);
  const info = rt.getConnectionInfo();
  assert.equal(info.enabled, true);
  assert.equal(info.running, true);
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.match(info.token, /^[0-9a-f]{48}$/);
  assert.equal(store.get('mcp.token'), info.token);
  await rt.stop();
  assert.equal(rt.isRunning(), false);
});

test('rotateToken changes token and keeps service running with it', async () => {
  const store = makeStore({});
  const rt = startMCP({ store, scheduler: fakeScheduler });
  await rt.start();
  const before = rt.getConnectionInfo();
  const next = await rt.rotateToken();
  assert.notEqual(next, before.token);
  assert.equal(rt.isRunning(), true);
  const after = rt.getConnectionInfo();
  assert.equal(after.token, next);
  assert.equal(after.port, before.port, '同端口重启(测试环境无占用)');
  await rt.stop();
});
```

`test/settings-security.test.js` 追加（读现有文件末尾，把下面用例加在文件最后）：

```js
test('mcp.enabled is writable but mcp.token stays a protected credential', () => {
  assert.equal(isWritableSettingKey('mcp.enabled'), true);
  assert.equal(isWritableSettingKey('mcp.token'), false);
});

test('sanitizeSettings strips mcp.token from renderer-bound copies', () => {
  const out = sanitizeSettings({ mcp: { enabled: true, token: 'secret-token' } });
  assert.equal(out.mcp.enabled, true);
  assert.equal(out.mcp.token, undefined);
});
```

（`isWritableSettingKey` / `sanitizeSettings` 已在该测试文件顶部 require，直接复用；若没有则加 `const { isWritableSettingKey, sanitizeSettings } = require('../src/main/core/settings-security');`）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/mcp-runtime.test.js test/settings-security.test.js`
Expected: runtime FAIL（模块不存在）；settings-security 两个新用例 FAIL

- [ ] **Step 3: 实现 `settings-security.js` 修改**

第 4-7 行的 `SECRET_SETTING_PATHS` 追加 mcp.token：

```js
const SECRET_SETTING_PATHS = [
  ['providers', 'deepseek', 'apiKey'],
  ['providers', 'deepseek', 'sessionToken'],
  ['mcp', 'token']
];
```

第 29 行白名单：

```js
const WRITABLE_SETTING_KEYS = new Set(['layout', 'componentOrder', 'providers.proxyUrl', 'mcp.enabled']);
```

- [ ] **Step 4: 实现 `src/main/mcp/index.js`**

```js
// MCP 服务运行时:装配 token/tools/server,提供开关与连接信息。
const { ensureMcpToken, rotateMcpToken } = require('./token');
const { buildToolHandlers } = require('./tools');
const { startMcpServer } = require('./server');

const BASE_PORT = 3950;
const MAX_PORT = 3959;

function startMCP(deps) {
  const store = deps.store;
  const scheduler = deps.scheduler;
  const logger = deps.logger || console;
  let server = null;

  const handlers = buildToolHandlers({
    getSnapshot: () => scheduler.getSnapshot(),
    getState: (id) => scheduler.getState(id),
    getUsageDaily: () => store.get('usageDaily'),
    now: () => Date.now()
  });

  function isEnabled() {
    return store.get('mcp.enabled') !== false;
  }

  async function start() {
    if (server || !isEnabled()) return;
    try {
      const token = ensureMcpToken(store);
      server = await startMcpServer({ basePort: BASE_PORT, maxPort: MAX_PORT, token, handlers, logger });
      logger.log('[mcp] listening at ' + server.url);
    } catch (e) {
      // MCP 启动失败不阻断主应用
      logger.error('[mcp] failed to start: ' + (e && e.message));
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
        enabled: isEnabled(),
        running: !!server,
        port: server ? server.port : null,
        url: server ? server.url : null,
        token: store.get('mcp.token') || null
      };
    },
    async rotateToken() {
      const token = rotateMcpToken(store);
      if (server) {
        await stop();
        await start();
      }
      return token;
    }
  };
}

module.exports = { startMCP, BASE_PORT };
```

- [ ] **Step 5: 接线 `src/main/index.js`**

顶部 require 区（第 27 行附近）加：

```js
const { startMCP } = require('./mcp');
```

模块级变量区（第 35 行 `let tray = null;` 附近）加：

```js
let mcpRuntime = null;
```

`app.whenReady().then(...)` 内 `startSchedulerRuntime();`（第 689 行）之后加：

```js
  mcpRuntime = startMCP({ store, scheduler, logger: console });
  mcpRuntime.start();
```

`applySetting` 函数内（找到其 switch/if 链）加分支：

```js
  if (key === 'mcp.enabled') {
    if (store.get('mcp.enabled') !== false) mcpRuntime.start();
    else mcpRuntime.stop();
  }
```

退出清理（第 751 行 `if (tray) { tray.destroy(); ... }` 附近）加：

```js
  if (mcpRuntime) { mcpRuntime.stop(); mcpRuntime = null; }
```

- [ ] **Step 6: 跑测试 + 全量回归**

Run: `node --test test/mcp-runtime.test.js test/settings-security.test.js`
Expected: 全部 pass
Run: `npm test`
Expected: 全量 pass（基线 487 + 新增），无回归

- [ ] **Step 7: Commit**

```bash
git add src/main/mcp/index.js src/main/index.js src/main/core/settings-security.js test/mcp-runtime.test.js test/settings-security.test.js
git commit -m "feat(mcp): 运行时装配+主进程接线+mcp.enabled 开关"
```

---

### Task 6: 设置面板 UI + IPC 连接信息 + 托盘复制

**Files:**
- Modify: `src/main/ipc.js`（新增 `mcp:getConnectionInfo`、`mcp:rotateToken` 两个 handler，deps 增加 `getMcpRuntime`）
- Modify: `src/main/index.js:691-713`（`setupIPC({...})` 调用处传 `getMcpRuntime: () => mcpRuntime`）；`updateTrayMenu()`（第 355-389 行）加"复制 MCP 连接信息"
- Modify: `src/preload/preload.js:51-64`（invoke 白名单加两个通道）
- Modify: `src/renderer/js/settings-definitions.js:65-70`（tailDefinitions 加 MCP 组）
- Modify: `src/renderer/js/settings-window.js`（新增 `mcpServer` 类型渲染：URL/token 只读框 + 复制 + 重新生成）
- Test: `test/mcp-ipc-static.test.js`（静态断言，风格同 `test/quota-card-static.test.js`）

**Interfaces:**
- Consumes: Task 5 的 `runtime.getConnectionInfo()` / `runtime.rotateToken()`；preload 的 `invoke(channel)`
- Produces:
  - IPC `mcp:getConnectionInfo -> {enabled, running, port, url, token}`；`mcp:rotateToken -> {enabled, running, port, url, token}`（轮换后最新值）
  - settings-definitions 新增项：`{ group: 'MCP 服务', key: 'mcp.enabled', type: 'toggle', label: '启用 MCP 服务', default: true }` 和 `{ group: 'MCP 服务', key: 'mcp.serverInfo', type: 'mcpServer', label: '连接信息', default: '' }`
  - 托盘菜单项 `复制 MCP 连接信息`（`clipboard.writeText(url + '\nBearer ' + token)`，服务未运行时禁用）

- [ ] **Step 1: 写失败测试（静态断言）**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

test('ipc registers mcp connection info and rotate handlers', () => {
  const ipc = read('src/main/ipc.js');
  assert.match(ipc, /ipcMain\.handle\('mcp:getConnectionInfo'/);
  assert.match(ipc, /ipcMain\.handle\('mcp:rotateToken'/);
});

test('preload whitelists the two mcp invoke channels', () => {
  const preload = read('src/preload/preload.js');
  assert.match(preload, /'mcp:getConnectionInfo'/);
  assert.match(preload, /'mcp:rotateToken'/);
});

test('settings definitions declare mcp.enabled toggle and mcpServer info block', () => {
  const defs = read('src/renderer/js/settings-definitions.js');
  assert.match(defs, /key: 'mcp\.enabled', type: 'toggle'/);
  assert.match(defs, /type: 'mcpServer'/);
});

test('settings window renders mcpServer block with copy and rotate actions', () => {
  const win = read('src/renderer/js/settings-window.js');
  assert.match(win, /mcpServer/);
  assert.match(win, /mcp:getConnectionInfo/);
  assert.match(win, /mcp:rotateToken/);
  assert.match(win, /clipboard/);
});

test('tray menu offers copying MCP connection info', () => {
  const index = read('src/main/index.js');
  assert.match(index, /复制 MCP 连接信息/);
  assert.match(index, /clipboard/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/mcp-ipc-static.test.js`
Expected: FAIL（断言不匹配）

- [ ] **Step 3: 实现 IPC（`src/main/ipc.js`）**

在 `setupIPC` 内 `sync:history` handler 之后追加（`deps.getMcpRuntime` 由 index.js 注入）：

```js
  ipcMain.handle('mcp:getConnectionInfo', () => {
    const rt = typeof deps.getMcpRuntime === 'function' ? deps.getMcpRuntime() : null;
    return rt ? rt.getConnectionInfo() : { enabled: false, running: false, port: null, url: null, token: null };
  });

  ipcMain.handle('mcp:rotateToken', async () => {
    const rt = typeof deps.getMcpRuntime === 'function' ? deps.getMcpRuntime() : null;
    if (!rt) throw new Error('MCP 服务未初始化');
    await rt.rotateToken();
    return rt.getConnectionInfo();
  });
```

- [ ] **Step 4: 实现 index.js 接线与托盘**

`setupIPC({...})` 参数对象（第 691-713 行）加一行：

```js
    getMcpRuntime: () => mcpRuntime,
```

`updateTrayMenu()` 模板在 `设置` 项之前插入（`clipboard` 并入第 1 行的 electron require）：

```js
    { type: 'separator' },
    {
      label: '复制 MCP 连接信息',
      enabled: !!(mcpRuntime && mcpRuntime.isRunning()),
      click: () => {
        const info = mcpRuntime.getConnectionInfo();
        clipboard.writeText(info.url + '\nAuthorization: Bearer ' + info.token);
      }
    },
```

第 1 行改为：

```js
const { app, BrowserWindow, Tray, Menu, nativeTheme, screen, clipboard } = require('electron');
```

- [ ] **Step 5: 实现 preload 白名单**

`src/preload/preload.js` invoke 白名单数组（第 51-64 行）末尾加：

```js
      'detect:proxy-port',
      'mcp:getConnectionInfo',
      'mcp:rotateToken'
```

- [ ] **Step 6: 实现设置面板**

`src/renderer/js/settings-definitions.js` 的 `tailDefinitions` 数组开头加：

```js
  { group: 'MCP 服务', key: 'mcp.enabled', type: 'toggle', label: '启用 MCP 服务', default: true },
  { group: 'MCP 服务', key: 'mcp.serverInfo', type: 'mcpServer', label: '连接信息', default: '' },
```

`src/renderer/js/settings-window.js`：找到渲染各 `type` 的分发处（参照现有 `historySync` / `proxy` 类型的渲染方式），新增 `mcpServer` 分支：

```js
  if (def.type === 'mcpServer') {
    const wrap = el('div', 'mcp-server-info');
    const urlInput = el('input', 'text-input');
    urlInput.readOnly = true;
    urlInput.value = '加载中...';
    const tokenInput = el('input', 'text-input');
    tokenInput.readOnly = true;
    tokenInput.value = '';
    const copyBtn = el('button', 'btn-secondary');
    copyBtn.textContent = '复制连接信息';
    const rotateBtn = el('button', 'btn-secondary');
    rotateBtn.textContent = '重新生成 token';
    wrap.appendChild(urlInput);
    wrap.appendChild(tokenInput);
    wrap.appendChild(copyBtn);
    wrap.appendChild(rotateBtn);

    function renderInfo(info) {
      urlInput.value = info.running ? info.url : (info.enabled ? '启动中/未运行' : '已关闭');
      tokenInput.value = info.token || '';
      copyBtn.disabled = !info.running;
      rotateBtn.disabled = !info.enabled;
    }
    window.api.invoke('mcp:getConnectionInfo').then(renderInfo).catch(() => {
      urlInput.value = '不可用';
    });
    copyBtn.addEventListener('click', () => {
      const text = urlInput.value + '\nAuthorization: Bearer ' + tokenInput.value;
      navigator.clipboard.writeText(text);
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制连接信息'; }, 1200);
    });
    rotateBtn.addEventListener('click', () => {
      rotateBtn.disabled = true;
      window.api.invoke('mcp:rotateToken').then(renderInfo).finally(() => {
        rotateBtn.disabled = false;
      });
    });
    return wrap;
  }
```

（`el(tag, className)` 辅助函数以该文件现有写法为准；若文件用的是直接 `document.createElement`，照其风格写。）

- [ ] **Step 7: 跑测试 + renderer 构建 + 全量回归**

Run: `node --test test/mcp-ipc-static.test.js`
Expected: 5 pass
Run: `npm test`
Expected: 全量 pass，无回归

- [ ] **Step 8: Commit**

```bash
git add src/main/ipc.js src/main/index.js src/preload/preload.js src/renderer/js/settings-definitions.js src/renderer/js/settings-window.js test/mcp-ipc-static.test.js
git commit -m "feat(mcp): 设置面板连接信息 UI + 托盘复制 + IPC 通道"
```

---

### Task 7: 全量验证 + PR

**Files:**
- 无新增；验收与交付

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 全量 pass / 0 fail（基线 487 + 本计划新增约 21 个）

- [ ] **Step 2: 打包冒烟（确认新依赖被 electron-builder 收编）**

Run: CI 的 `windows-package` 会自动验证；本地可选 `npx electron-builder --win --dir`
Expected: 产出目录 `resources/app/node_modules/@modelcontextprotocol/sdk` 存在

- [ ] **Step 3: 手动冒烟（开发态）**

```bash
npm start
# 另开终端:
curl -s -X POST http://127.0.0.1:3950/mcp ^
  -H "Authorization: Bearer <设置面板里的 token>" ^
  -H "Content-Type: application/json" ^
  -H "Accept: application/json, text/event-stream" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"curl\",\"version\":\"0\"}}}"
```

Expected: 返回含 `"name":"tokenmonitor"` 的 initialize 结果；不带 token 时 401。

- [ ] **Step 4: PR + CI + 合并**

```bash
git push -u origin feat/mcp-readonly-usage
gh pr create --title "feat(mcp): 只读用量 MCP 服务(Streamable HTTP)" --body "<按提交摘要填写>"
sleep 20 && gh pr checks --watch
gh pr merge --rebase
git checkout main && git pull origin main
git branch -d feat/mcp-readonly-usage && git push origin --delete feat/mcp-readonly-usage
```

Expected: 三项 CI 全绿，main 已同步。

---

## Self-Review 记录

- **Spec 覆盖**：传输/鉴权（Task 4）、数据语义与字段（Task 2/3）、默认开启+开关（Task 5/6）、命名 tokenmonitor（Task 4 serverInfo、Task 3 resource URI）、凭证通道与白名单（Task 5）、DNS rebinding（Task 4 Host 校验）、端口回退+提示（Task 4/6）、托盘复制（Task 6）、stateless（Task 4）、无 cost（Task 2/3 不输出）、测试三项（Task 2/3/4）、依赖打包（Task 4 Step 1 + Task 7 Step 2）、错误处理（Task 4 各分支 + Task 5 start try/catch）——全覆盖。
- **类型一致性**：`buildToolHandlers` 五 handler 名在 Task 3 定义、Task 4 测试 mock、Task 5 装配一致；`runtime` 五方法名在 Task 5 定义、Task 6 IPC/托盘消费一致；`getConnectionInfo` 返回五字段处处一致。
- **占位符**：Task 6 Step 6 的 `el()` 注明以文件现有风格为准（该文件 DOM 辅助风格需实现者现场确认），其余步骤代码完整。
