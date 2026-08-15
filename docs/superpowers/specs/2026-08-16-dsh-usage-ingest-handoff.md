# DSH Usage 被动接收交接文档（TokenMonitor 侧）

日期：2026-08-16
状态：待复审（已按评审意见修订）

## 1. 目标

把 TokenMonitor 对 dsh usage 的监控从「主动读本地文件」演进为「**dsh 主动推送、TokenMonitor 被动接收**」：

- dsh 侧通过一个**默认禁用的 exporter 插件**推送 usage；
- 所有 dsh 实例（本机、远程、多端）通过同一入口收敛；
- TokenMonitor 保留本地文件扫描作为老版本兜底和历史回填通道；
- push 与 localLog 通过 `rootId` 与采集模式协调，避免同一份遥测被重复记账。

本文件定义 TokenMonitor 需要实现的 HTTP 契约、配置、幂等与合并语义；dsh 侧实现见 deepseek-harness 仓库的设计文档 `2026-08-16-dsh-usage-telemetry-push-design.zh.md`（该文档已同步 `rootId` 与 heartbeat 语义，本交接文档以该中文版本为准）。

## 2. 现状

- dsh 的 `usage-telemetry` 插件把每次带 session 归属的模型调用写为 JSONL：
  `$DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl`；
- TokenMonitor 的 `providers/dsh/telemetrylog.js` 以 offset 游标扫描该文件，并生成 `UsageRecord`；
- dsh provider 当前 capabilities：`{ localLog: true }`；
- localLog 轮询、手动历史重扫目前都直接写 `usageDaily` / `usageDailyCost` 的 `dsh:` 前缀键；
  手动重扫（`sync:history` → `rescanLocalLogs`）会先清空这些键再从本地文件重建。

## 3. 目标数据流

```
多台 dsh 实例
   └─ usage-exporter 插件(默认关闭,启用后 tail 本地 JSONL)
        └─ POST /api/v1/dsh/usage  (Bearer ingest token)
             └─ TokenMonitor ingest 模块
                  ├─ 整批校验 + rootId 识别
                  ├─ (sourceId, batchId) 幂等检查
                  ├─ 复用文件扫描的行 → UsageRecord 映射
                  ├─ 经 dsh 用量提交串行队列,原子提交:
                  │     usageDailyPush / usageDailyCostPush + batch 注册表
                  └─ 广播 providers:changed / token-speed 观察

展示层
   └─ dsh 有效日聚合 = usageDaily(本地文件) + usageDailyPush(推送)
```

## 4. TokenMonitor 需要交付

1. 一个本地 HTTP 服务：`POST /api/v1/dsh/usage`（默认 `127.0.0.1`，端口可配置，见 5.0）；
2. 一个独立的 ingest token，与 MCP 只读 token 分开生成、存储与展示；
3. **持久化**的 batch 幂等注册表（按 `(sourceId, batchId)`，带 TTL，与账本原子提交）；
4. dsh 行 → `UsageRecord` 的映射复用现有 `telemetrylog.js` 算法，并把「行映射」与「聚合提交」提炼为共享函数供文件扫描与 ingest 两个入口调用；
5. 基于 `rootId` + 采集模式（`auto` / `localLog` / `push`）的 localLog 抑制与恢复逻辑；
6. dsh 用量提交串行队列：ingest、localLog 增量扫描、手动重扫三个入口共享同一 FIFO，杜绝并发覆盖；
7. 独立的 push 聚合存储（`usageDailyPush` / `usageDailyCostPush`），展示层合并本地与推送两部分；
8. ingest 成功落库后刷新 token-speed 并广播 `providers:changed`，且永久拒绝/幂等冲突等诊断计数可见。

## 5. HTTP 契约

### 5.0 服务与配置

- 默认监听 `127.0.0.1`，基础端口 `29351`，占用时在 `29351–29360` 间回退，全部不可用时使用 ephemeral 端口；
- 配置键：
  - `ingest.dsh.enabled`：默认 `true`；
  - `ingest.dsh.listenHost`：默认 `127.0.0.1`；非 loopback 必须显式配置；
  - `ingest.dsh.port`：可选，覆盖基础端口；
  - `ingest.dsh.token`：`role(secret)`，首次启动自动生成，支持轮换；
  - `ingest.dsh.batchTtlDays`：默认 `7`；
  - `ingest.dsh.pushLeaseMs`：默认 `600000`（10 分钟），最小 `180000`（3 分钟）；
  - `ingest.dsh.rateLimitPerSourcePerMinute`：默认 `30`；
- dsh 采集模式配置 `providers.dsh.collectionMode`：默认 `auto`，可选 `localLog` / `push`，语义见第 7 节；
- 持久化键：`ingest.dsh.batchRegistry`（幂等注册表）、`ingest.dsh.sources`（source 活跃状态）；
- 设置页展示实际 endpoint URL 与 token 复制/轮换入口（样式与 MCP 连接信息一致）；token 值不进入渲染进程 settings 载荷。

### 5.1 请求

```http
POST /api/v1/dsh/usage
Authorization: Bearer <ingest-token>
Content-Type: application/json
```

Body：

```json
{
  "sourceId": "my-laptop-a1b2c3",
  "rootId": "root:<sha256-hex>",
  "batchId": "sha256:<hex>",
  "sentAt": 1786817351458,
  "rows": [
    {
      "v": 1,
      "time": 1786817351458,
      "sessionId": "session-...",
      "cwd": "/home/user/project",
      "model": "deepseek-v4-pro",
      "inputTokens": 4298,
      "outputTokens": 378,
      "cacheReadTokens": 377600,
      "cacheWriteTokens": 0
    }
  ]
}
```

字段约束：

| 字段 | 约束 |
|---|---|
| `sourceId` | 必填，`[A-Za-z0-9._-]{1,64}`，唯一标识一个 dsh 实例，由 dsh 配置或自动生成；运维上必须保证全局唯一 |
| `rootId` | 必填，`root:` + 64 hex；由 exporter 从本地遥测根目录按 5.1.1 派生，供 TokenMonitor 识别来源文件根 |
| `batchId` | 普通 batch 必填，同一批重试时保持不变；`sha256:` + 64 hex；heartbeat 请求不得携带 |
| `sentAt` | 必填，epoch ms，safe integer |
| `heartbeat` | 可选 boolean；`true` 时表示租约续期请求，`rows` 必须省略或为空数组，且不得携带 `batchId`；`false` 或省略按普通 batch 处理 |
| `rows` | 普通 batch 必填，1–1000 行；整包 ≤ 1 MiB；heartbeat 请求中省略或为空 |
| `rows[].v` | 必须为 `1`，否则该行拒绝 |
| `rows[].time` | epoch ms，safe integer，且满足与文件扫描相同的规范化窗口：`[2000-01-01, TokenMonitor 时钟 + 24h]` |
| `rows[].sessionId` | 非空 string |
| `rows[].cwd` | 可选 string |
| `rows[].model` | 可选 string |
| token 四桶 | `Number.isSafeInteger` 且 `>= 0` |
| envelope / rows 未知字段 | 忽略，用于前向兼容 |

#### 5.1.1 `rootId` 派生规则

- exporter 与 TokenMonitor 使用**同一规范化函数**，对各自环境中实际生效的绝对遥测根路径计算：
  - exporter 侧：若配置了 `telemetryRoot` 则以其为准，否则
    `path.resolve(join(resolveDshHome(), 'telemetry'))`；
  - TokenMonitor 侧对 `resolveTelemetryRoot(store, env)` 的结果计算；
  - Windows：把 `\` 替换为 `/`，并对整串 `toLowerCase()`；非 Windows 保持原串；
  - `rootId = 'root:' + sha256_hex(UTF-8(canonicalPath))`。
- 只有原生路径空间下双方结果一致时（例如同一 Windows 机器上的 Windows dsh 与 TokenMonitor）才视为同一根。
- WSL 路径 `/home/...` 与 Windows UNC `\\wsl.localhost\...` 属于不同命名空间，**v1 不自动匹配**；此时如需停用对应 localLog，使用 `providers.dsh.collectionMode = 'push'`（见第 7 节）。

### 5.2 响应

成功：

```json
{ "ok": true, "accepted": 10, "duplicates": 0 }
```

重复 batch（已确认过，且行内容指纹一致）：

```json
{ "ok": true, "accepted": 0, "duplicates": 10 }
```

Heartbeat：

```json
{ "ok": true, "heartbeat": true }
```

失败：

| 状态 | 场景 | 响应体示例 |
|---|---|---|
| 400 | JSON/格式/字段校验失败 | `{ "ok": false, "code": "invalid-row", "message": "...", "index": 3 }` |
| 401 | token 错误 | `{ "ok": false, "code": "unauthorized", "message": "..." }` |
| 409 | 同一 `(sourceId, batchId)` 重试但行内容不同 | `{ "ok": false, "code": "batch-conflict", "message": "..." }` |
| 413 | 包过大 | `{ "ok": false, "code": "batch-too-large", "message": "..." }` |
| 429 | 限流 | `{ "ok": false, "code": "rate-limited", "message": "..." }` + `Retry-After` |
| 503 | 幂等注册表容量耗尽 | `{ "ok": false, "code": "registry-full", "message": "..." }` |
| 5xx | 内部错误 | `{ "ok": false, "code": "internal", "message": "..." }` |

400 的 `code` 全集：

| code | 含义 |
|---|---|
| `invalid-json` | body 不是合法 JSON |
| `invalid-envelope` | 顶层结构缺失/类型错误 |
| `invalid-source-id` | `sourceId` 不合法 |
| `invalid-root-id` | `rootId` 格式不合法 |
| `invalid-batch-id` | `batchId` 格式不合法 |
| `invalid-sent-at` | `sentAt` 不合法 |
| `invalid-rows` | 普通 batch 的 `rows` 不是 1–1000 行数组 |
| `invalid-heartbeat` | `heartbeat` 类型错误，或 heartbeat 请求携带了 `batchId`/非空 `rows` |
| `invalid-row` | 某行字段非法；附带 `index` |

- 校验是**整批 all-or-nothing**：普通 batch 任一 envelope 字段或任一行非法即返回 400，不写任何账本或注册表；heartbeat 请求只校验 `sourceId`/`rootId`/`sentAt`/`heartbeat`，不触碰账本与注册表。
- 429 使用按 `sourceId` 的令牌桶，默认 30 请求/分钟；`Retry-After` 为建议等待秒数。
- 5xx 响应不泄露内部堆栈。

### 5.3 幂等

- 幂等键是 `(sourceId, batchId)`；
- dsh exporter 在 HTTP 失败时用**同一个 batchId** 重试，直到成功或判定为永久失败；
- TokenMonitor 收到重复 batch 时直接返回成功，不重复记账；
- **不要**跨 batch 用行内容指纹去重：同一毫秒、同会话、同模型的两次真实调用可能产生完全相同行，内容去重会漏记；
- 注册表**必须持久化**（建议 store 键 `ingest.dsh.batchRegistry`），不能只在内存：应用重启后重试不得造成重复入账；
- 注册表项至少包含 `{ sourceId, batchId, rowCount, bodyHash, acceptedAt }`，其中 `bodyHash = sha256(规范化 rows JSON)`；规范化指保留 rows 数组顺序、每个 row 按字段表键序重新序列化、未知字段按键名排序追加、去除空白后做 UTF-8 序列化；
- 重复请求处理：
  - `(sourceId, batchId)` 已存在且 `bodyHash` 一致 → `200 { ok:true, accepted:0, duplicates:<rowCount> }`；
  - `(sourceId, batchId)` 已存在但 `bodyHash` 不同 → `409 batch-conflict`，不写账本；
- TTL 默认 7 天（覆盖 exporter 最长重试窗口），启动时与每小时间隔清理过期项；注册表设总条数上限（建议 200,000），超过时**只淘汰已过期项**；若淘汰后仍超限，拒绝新 batch 并返回 `503 registry-full`，不得淘汰未过期项（否则破坏幂等保证）；
- **原子提交**：`usageDailyPush` / `usageDailyCostPush` 的合并结果与 batch 注册表必须在同一次 store 快照提交中落盘，复用 `commitTelemetryScanState` 的整体快照替换模式；任何一步失败都不留下“已记账但未确认”或“已确认但未记账”的状态；
- 设置重置必须保留 push 账本、注册表与 source 活跃状态：把 `usageDailyPush`、`usageDailyCostPush`、`ingest.dsh.batchRegistry`、`ingest.dsh.sources` 一并加入 `settings-reset.js` 的 `RESET_KEEP_KEYS`，与 `usageDaily` / 游标同等对待。

## 6. 行映射与存储

### 6.1 行映射

复用 `providers/dsh/telemetrylog.js` 现有算法，并把 `parseTelemetryLine` 的「行对象 → `UsageRecord`」部分提炼为共享函数（文件扫描与 ingest 都调用）：

```text
ts                = normalizeTimestampMs(rows[].time)   // [2000-01-01, now + 24h]
date              = localDayStr(ts)                      // 北京时区口径
usage.input       = inputTokens + cacheWriteTokens
usage.cached      = cacheReadTokens
usage.output      = outputTokens
usage.total       = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens
cost              = calcDshCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, ts)
eventFingerprint  = sha256(new Date(ts).toISOString(), sessionId, model,
                            inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens)
```

说明：

- `eventFingerprint` 仅用于诊断/审计，不作为 ingest 幂等键；
- 未知模型按现有规则记 0 费用并计诊断；
- ingest 不得实现第二套汇总公式；日键、四桶、费用、未知模型诊断全部与文件扫描同源。

### 6.2 聚合存储拆分

为避免「手动重扫本地文件」删除推送数据：

- localLog 继续写 `usageDaily` / `usageDailyCost` 的 `dsh:` 前缀键，行为不变；
- ingest 写 `usageDailyPush` / `usageDailyCostPush`，键名仍为 `dsh:YYYY-MM-DD`；
- 展示层（dashboard、heatmap、token-speed、MCP 投影）对 dsh 的读取必须合并两份存储：
  `effective.dsh[day] = usageDaily['dsh:'+day] + usageDailyPush['dsh:'+day]`（费用同理）；
- 历史保留清理（`usage-retention`）必须同时作用于两份存储；
- `sync:history` 对 dsh 的手动重扫只清空/重建 `usageDaily`、`usageDailyCost` 与 `localLogCursors.dsh`，**不触碰 push 两份存储**。

## 7. 与 localLog 的共存

- exporter 默认从文件**当前 EOF** 开始 tail，不推历史；
- 因此：开启 push 之前的历史仍由现有文件扫描补录；
- 未启用 exporter 的 dsh 实例继续走现有 `localLog`，行为不变。

TokenMonitor 新增 dsh 采集模式设置 `providers.dsh.collectionMode`，默认 `auto`：

| 模式 | 行为 |
|---|---|
| `auto` | 当存在「活跃 push source」且其 `rootId` 与 TokenMonitor 当前解析出的 `resolveTelemetryRoot` 一致时，停止该根的日常 `localLog` 轮询；否则正常轮询 |
| `localLog` | 始终轮询本地遥测文件（即使同根 source 也在 push；操作者需自行避免同一根同时双通道） |
| `push` | 停止 dsh 的日常 `localLog` 轮询，只接收 push；手动重扫/回填入口仍保留 |

活跃 push source 定义：

- TokenMonitor 首次收到某 `sourceId` 的成功 batch 后，记录 `ingestStartedAt` 与 `lastIngestAt`；未知 source 的 heartbeat 同样记录 `rootId` 与 `lastIngestAt`，但 `ingestStartedAt` 保持为空直到首个成功 batch；
- 成功 batch 或 heartbeat 每次更新 `lastIngestAt`；
- `ingestStartedAt` / `lastIngestAt` / `rootId` 持久化在 `ingest.dsh.sources`，TokenMonitor 重启后立即恢复 push 模式判断，不等首个 batch；
- 某 source 在 `ingest.dsh.pushLeaseMs`（默认 10 分钟）内既无成功 batch 也无 heartbeat，视为失联；
- dsh exporter 以 `heartbeatIntervalMs`（默认 60s）发送 heartbeat；TokenMonitor 的 `pushLeaseMs` 必须大于 3 倍 exporter 心跳间隔（默认 10min > 3×60s），保证空闲 dsh 不会因租约到期被误判失联；用户自行调整时必须维持 `pushLeaseMs > 3 × heartbeatIntervalMs`；
- `auto` 模式在某根的全部 push source 都失联后，自动恢复该根的 localLog 轮询；
- `auto` 模式不匹配任何本地根时（WSL 路径 vs Windows 默认根、远程 source 等），localLog 保持原样，只叠加 push 数据；只要双方根目录确实不同，就不会重复计数。

边界与限制：

- 跨 OS 文件命名空间（如 TokenMonitor 经 `\\wsl.localhost\...` 扫描 WSL 遥测、而 exporter 报 `/home/...` 的 `rootId`）v1 不做自动匹配；同一根确实双通道启用时应显式把 `collectionMode` 设为 `push`（或 `localLog`）；
- 手动重扫/回填入口在设置页「用量历史同步」，按 6.2 只重建本地文件部分，推送数据不受影响；
- dsh exporter 对 400/413 判永久失败并推进游标，这些行仍留在本地 JSONL 中，可通过手动重扫补回；TokenMonitor 必须持久计数并按 `(sourceId, code)` 暴露在诊断页，永久拒绝不得静默消失。

## 8. 安全

- ingest token 与 MCP 只读 token 分离；token 按 `role(secret)` 存储，日志与渲染进程 settings 载荷不得出现 token；
- 默认只绑定 `127.0.0.1`；非 loopback 监听必须显式配置 `ingest.dsh.listenHost`，并在设置页明示当前监听地址；
- 沿用 MCP server 的 Host 白名单校验（仅允许 `127.0.0.1` / `localhost`），阻止 DNS rebinding 类请求；token 比较采用常量时间实现；
- 请求体读取设 1 MiB 硬上限，超限返回 413，不解析、不落盘；
- 不提供 CORS 许可；该端点只面向服务器侧 HTTP 客户端；
- `cwd` 可能包含路径信息，只发送到用户配置的受信端点；
- 日志不打印 token，不打印完整 body（可打印 sourceId/batchId/行数/错误码）。

## 9. 非目标（本期不做）

- TokenMonitor 反向向 dsh 下发配置；
- dsh 多进程同时写同一遥测文件的一致性（沿用现有单实例假设）；
- 通用多租户/团队看板的后端扩容；
- 跨 OS 文件命名空间的自动 `rootId` 匹配（WSL/UNC 等场景用显式 `collectionMode` 覆盖）；
- 按 `sourceId` 分开展示/记账：所有 source 收敛到同一个 dsh 总量。

## 10. 验收清单

- [ ] `POST /api/v1/dsh/usage` 可接收合法 batch，并原子写入 `usageDailyPush` / `usageDailyCostPush` 与 batch 注册表；
- [ ] 有效 dsh 聚合 = 本地 + push，dashboard/heatmap/token-speed/MCP 读取一致；
- [ ] 重复 batch 返回 `duplicates` 且不重复记账；应用重启后重试同一 batch 仍幂等；
- [ ] 同一 `(sourceId, batchId)` 不同内容返回 `409 batch-conflict`；
- [ ] 任一 envelope/行字段非法时整批 400、零写入；400/401/409/413/429/503/5xx 均有明确响应；
- [ ] 429 返回 `Retry-After`，限流按 sourceId 生效；
- [ ] 与文件扫描产生的 `UsageRecord` 映射结果一致（用同一批 JSONL 行做对照测试）；
- [ ] `auto` 模式下，`rootId` 匹配且 source 活跃时停止对应 localLog 轮询；source 失联超过租约后自动恢复；
- [ ] heartbeat 返回 `{ ok:true, heartbeat:true }`，不写账本与注册表，并创建/续租 source 活跃状态；
- [ ] TokenMonitor 重启后由 `ingest.dsh.sources` 恢复 auto 抑制，首个 batch 到达前 localLog 不重复计数；
- [ ] `collectionMode = push` 停止 localLog 轮询但保留手动重扫；`collectionMode = localLog` 恢复轮询；
- [ ] 手动重扫只重建本地部分，push 聚合与 batch 注册表不被清除；
- [ ] 设置重置后 push 账本、batch 注册表与 source 活跃状态保留，历史重试仍幂等；
- [ ] 未开启 push 的 dsh 仍可被文件扫描正常监控，且不与 push 重复计数；
- [ ] ingest 落库后广播 `providers:changed` 并刷新 token-speed，无需等待 60s 轮询；
- [ ] ingest token 与 MCP token 相互独立，可分别轮换；
- [ ] dsh exporter 请求含 `rootId`，且双方派生规则一致（Windows 原生路径用例）。

## 11. 本修订相对初稿的关键决策

1. 增加必填 `rootId`（5.1.1），解决「sourceId 无法定位遥测根目录」的缺口；
2. 幂等注册表明确为持久化、有界、与账本同快照原子提交，并定义 `batch-conflict` 与整批 all-or-nothing（5.3）；
3. ingest 与 localLog/手动重扫共享 dsh 用量提交串行队列（第 4 节第 6 项）；
4. push 与本地聚合分仓存储，手动重扫不再删除推送数据（6.2、7）；
5. localLog 抑制改为 `rootId` + 采集模式 + 活跃租约，并定义失联恢复（7）；
6. 补齐 endpoint/端口/token/限流等配置、错误码全集与时间窗口（5.0、5.1、5.2）；
7. 同步 dsh 侧补充的 heartbeat 续租语义：heartbeat 不记账、未知 source 可先续租、source 状态持久化于 `ingest.dsh.sources`，并固定 `pushLeaseMs > 3 × heartbeatIntervalMs` 的协调不等式（5.0、7）。
