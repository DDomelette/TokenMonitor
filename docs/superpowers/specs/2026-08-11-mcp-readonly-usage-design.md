# Token Monitor — MCP 只读用量服务设计

> 日期：2026-08-11
> 状态：已确认（brainstorming 通过）

## 背景与目标

让外部工具通过 Model Context Protocol（MCP）读取 Token Monitor 内部数据——本版本只做**只读**的"各 Provider 剩余用量"读取，不做任何写操作。

本项目现名 **tokenmonitor**（旧名 `deepseek-monitor` 已弃用，整体更名作为独立后续任务，不在本设计范围内）。本设计中所有对外标识统一使用 `tokenmonitor`。

目标客户端：
- VS Code（Streamable HTTP）
- Cursor（Streamable HTTP）
- Codex CLI（Streamable HTTP，经 `~/.codex/config.toml` 的 `mcp_servers.<id>.url`）

## 决策记录（已确认）

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | 传输方式 | **Streamable HTTP**（`127.0.0.1:3950/mcp` + Bearer token） | 三种目标客户端均原生支持 HTTP，无需 stdio/桥接；单实例复用常驻实时快照 |
| 2 | 数据语义 | **Provider 级剩余**（余额/订阅窗口）+ **模型级已消耗**（usageDaily） | 现有数据模型中"剩余"是 Provider 级，模型级只有已消耗；无模型级剩余额度数据源 |
| 3 | 启用方式 | **默认开启**，设置面板/托盘可随时关闭 | 用户体验优先 |
| 4 | 命名 | MCP 标识 `tokenmonitor`，Resource URI `tokenmonitor://...` | 新名统一 |
| 5 | 更名范围 | 本次只做 MCP（新代码/文档用 tokenmonitor）；整体更名（package.json/productName/数据目录迁移）后续单独任务 | 控制范围 |

## 架构概览

```
┌────────────────────────────────────────────────────────────┐
│  Electron 主进程 (src/main)                                  │
│                                                             │
│  index.js ── app.whenReady ──► startSchedulerRuntime()      │
│                    │                                        │
│                    └──► startMCP()  [新]                     │
│                          │                                  │
│                          ▼                                  │
│                    src/main/mcp/                             │
│                    ├─ server.js   Streamable HTTP 服务       │
│                    │   127.0.0.1:3950/mcp  (Bearer token)    │
│                    ├─ tools.js    MCP 工具/资源定义(只读)     │
│                    ├─ projection.js  mcp-safe 快照投影(纯函数)│
│                    └─ token.js    token 生成/持久化           │
│                                                             │
│  数据源: scheduler.getSnapshot() / getState()               │
│          + store['usageDaily'] (只读,脱敏)                   │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP (loopback, Bearer token)
                               ▼
        ┌─────────────┬──────────────┬──────────────┐
        ▼             ▼              ▼
     VS Code      Cursor        Codex CLI
  (.vscode/mcp.json) (MCP Servers)  (~/.codex/config.toml)
```

## 模块划分（均在 `src/main/mcp/`）

| 模块 | 职责 | 依赖 | 可单测 |
|------|------|------|--------|
| `server.js` | 启动/停止本地 HTTP 服务，`@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport`；绑定 `127.0.0.1:3950`；校验 `Authorization: Bearer <token>`；处理端口占用（+1 回退） | 主进程 | 部分（集成） |
| `tools.js` | 注册 MCP Tool/Resource，全部只读；handler 调用 `projection` | 纯逻辑 | 是 |
| `projection.js` | 把 `scheduler.getSnapshot()` + `usageDaily` 映射为对外安全的 JSON（纯函数，断言不含凭证） | 纯函数 | 是 |
| `token.js` | 启动时生成随机 token，持久化到 store（`mcp.token`），暴露给设置面板/托盘 | store | 是 |

### 数据流

1. `startMCP(deps)` 在 `app.whenReady` 后、`startSchedulerRuntime()` 之后调用；
2. `server.js` 用 `token.js` 提供的 token 鉴权，实例化 `StreamableHTTPServerTransport`；
3. 每次 MCP 工具调用 → `tools.js` handler → `projection.js` 读 `deps.scheduler.getSnapshot()` / `getState(pid)` / `store.get('usageDaily')` → 返回脱敏 JSON；
4. 数据实时性由现有 scheduler 轮询保证（usage 10s / quota 60s / balance 60s / localLog 60s），MCP 不做额外采集。

## MCP 能力（v1 只读）

### Tools

| 名称 | 参数 | 返回 |
|------|------|------|
| `list_providers` | 无 | `[{id, displayName, capabilities, authStatus, stale, lastFetchedAt}]` |
| `get_remaining_usage` | `provider?` | 各 Provider：`billingMode`、余额 `{total, granted, toppedUp, currency}`、订阅窗口 `[{kind, used, limit, remaining, resetsAt}]`、`fetchedAt`、`stale` |
| `get_model_usage` | `{provider?, date?}`（`date` 为 `'YYYY-MM-DD'` 本地时区，缺省为今日） | 模型级 `[{model, inputTokens, outputTokens, cachedTokens, cost}]`（源自 `usageDaily`） |
| `get_usage_summary` | `provider?` | 今日各 Provider 汇总（tokens/cost/cached） |

### Resources

| URI | 内容 |
|-----|------|
| `tokenmonitor://quota` | 全部 Provider 额度快照（同 `get_remaining_usage` 无参） |

> 所有返回都带 `authStatus` / `stale` 标记，过期数据明确标注。

## 安全边界

1. **凭证零暴露**：数据只取自 `scheduler.getSnapshot()` 与 `usageDaily`（本身无凭证）；`projection.js` 单测断言输出不含 `apiKey` / `sessionToken` 键。
2. **只监听 loopback**：仅 `127.0.0.1`，拒绝 `0.0.0.0`。
3. **Bearer token 鉴权**：启动时随机生成，持久化 `mcp.token`；无 token / 错误 token → 401。
4. **只读**：v1 无任何写操作。
5. **过期态透传**：`authStatus === 'expired'` 或 `stale` 时返回里带标记。

## 客户端接入

### VS Code（`.vscode/mcp.json` 或用户级 `settings.json`）

```json
{
  "servers": {
    "tokenmonitor": {
      "type": "http",
      "url": "http://127.0.0.1:3950/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### Cursor（Settings → MCP Servers）

- Type: `http`
- URL: `http://127.0.0.1:3950/mcp`
- Headers: `Authorization: Bearer <token>`

### Codex CLI（`~/.codex/config.toml`）

```toml
[mcp_servers.tokenmonitor]
url = "http://127.0.0.1:3950/mcp"
http_headers = { "Authorization" = "Bearer <token>" }
# 可选：从环境变量取 token，避免明文写在 config.toml
# bearer_token_env_var = "TOKENMONITOR_MCP_TOKEN"
```

> `required` 保持默认 `false`，Token Monitor 未运行时 Codex 不因连不上而卡启动。

## 启用 / UI

- **默认开启**；端口固定 `3950`（占用则 `3951` 起 +1 回退），token 随机；
- 设置面板新增"MCP 服务"开关 + 显示 `URL` / `token` / 一键复制；
- 托盘菜单加"复制 MCP 连接信息"项；
- 关闭后释放端口，重开即恢复。

## 错误处理

- 端口占用 → +1 回退并记录日志；
- 无/错误 token → HTTP 401；
- 调度器未就绪 / 数据为空 → 返回 `{status:'pending'}` 而非抛错；
- MCP 服务启动失败不阻断主应用（try/catch + 日志）。

## 测试

- `test/mcp-projection.test.js` — 快照投影纯函数：字段映射、无凭证断言、stale/authStatus 透传、空数据处理；
- `test/mcp-tools.test.js` — tools 定义与参数校验（含 provider/date 参数合法性）；
- 沿用现有 `node --test` 体系，纯函数/无 Electron 依赖。

## 依赖与打包

- 新增生产依赖 `@modelcontextprotocol/sdk`（纯 JS，无原生依赖；Electron 40 内嵌 Node 22 满足要求）；
- `electron-builder` 自动打包该依赖（`files` 已含 `node_modules/**/*`）；
- 不改动现有采集链路；`startMCP` 独立接线。

## 非目标（YAGNI）

- ❌ 不做写操作（设置修改、布局写入等一律排除）；
- ❌ 不做 stdio 桥接 / `--mcp` 无头模式（当前三种客户端均走 HTTP）；
- ❌ 不做模型级"剩余额度"（数据源不存在，只有 Provider 级剩余 + 模型级已消耗）；
- ❌ 不做整体更名（独立后续任务）；
- ❌ 不做 MCP 鉴权外的额外加密/公网暴露。

## 后续任务（独立于本设计）

- 整体更名 `deepseek-monitor` → `tokenmonitor`（package.json / productName / appId / `%APPDATA%` 数据目录迁移 / tooltip / User-Agent / renderer title / docs）。
