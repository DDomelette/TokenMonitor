# DSH Usage 被动接收交接文档（TokenMonitor 侧）

日期：2026-08-16
状态：待评审

## 1. 目标

把 TokenMonitor 对 dsh usage 的监控从「主动读本地文件」演进为「**dsh 主动推送、TokenMonitor 被动接收**」：

- dsh 侧通过一个**默认禁用的 exporter 插件**推送 usage；
- 所有 dsh 实例（本机、远程、多端）通过同一入口收敛；
- TokenMonitor 保留本地文件扫描作为老版本兜底和历史回填通道。

本文件只定义 TokenMonitor 需要实现的 HTTP 契约与合并语义；dsh 侧实现见 deepseek-harness 仓库的设计文档。

## 2. 现状

- dsh 的 `usage-telemetry` 插件把每次带 session 归属的模型调用写为 JSONL：
  `$DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl`；
- TokenMonitor 的 `providers/dsh/telemetrylog.js` 以 offset 游标扫描该文件，并生成 `UsageRecord`；
- dsh provider 当前 capabilities：`{ localLog: true }`。

## 3. 目标数据流

```
多台 dsh 实例
   └─ usage-exporter 插件(默认关闭,启用后 tail 本地 JSONL)
        └─ POST /api/v1/dsh/usage  (Bearer ingest token)
             └─ TokenMonitor ingest 模块
                  ├─ 校验/去重 batchId
                  ├─ 映射为 UsageRecord
                  └─ 写入 usageDaily/usageDailyCost(与现有文件扫描同一套存储)
```

## 4. TokenMonitor 需要交付

1. 一个本地 HTTP 路由：`POST /api/v1/dsh/usage`；
2. 一个独立的 ingest token（建议与 MCP 只读 token 分开管理）；
3. batch 幂等注册表（按 `sourceId` 记录已确认的 `batchId`，带 TTL）；
4. dsh 行 → `UsageRecord` 的映射复用现有 `telemetrylog.js` 的算法；
5. 当某 source 进入 push 模式后，停止对该遥测根目录的日常 `localLog` 轮询（保留手动回填能力）。

## 5. HTTP 契约

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
| `sourceId` | `[A-Za-z0-9._-]{1,64}`，唯一标识一个 dsh 实例，由 dsh 配置或自动生成 |
| `batchId` | 同一批重试时保持不变；`sha256:` + 64 hex |
| `sentAt` | epoch ms，safe integer |
| `rows` | 1–1000 行；整包 ≤ 1 MiB |
| `rows[].v` | 必须为 `1`，否则该行拒绝 |
| `rows[].time` | epoch ms，safe integer |
| `rows[].sessionId` | 非空 string |
| `rows[].cwd` | 可选 string |
| `rows[].model` | 可选 string |
| token 四桶 | `Number.isSafeInteger` 且 `>= 0` |
| 未知字段 | 忽略，用于前向兼容 |

### 5.2 响应

成功：

```json
{ "ok": true, "accepted": 10, "duplicates": 0 }
```

重复 batch（已确认过）：

```json
{ "ok": true, "accepted": 0, "duplicates": 10 }
```

失败：

| 状态 | 场景 | 响应体示例 |
|---|---|---|
| 400 | 格式/校验失败 | `{ "ok": false, "code": "invalid-row", "message": "...", "index": 3 }` |
| 401 | token 错误 | `{ "ok": false, "code": "unauthorized", "message": "..." }` |
| 413 | 包过大 | `{ "ok": false, "code": "batch-too-large", "message": "..." }` |
| 429 | 限流 | `{ "ok": false, "code": "rate-limited", "message": "..." }` + `Retry-After` |
| 5xx | 内部错误 | `{ "ok": false, "code": "internal", "message": "..." }` |

### 5.3 幂等

- 幂等键是 `(sourceId, batchId)`；
- dsh exporter 在 HTTP 失败时用**同一个 batchId** 重试，直到成功或判定为永久失败；
- TokenMonitor 收到重复 batch 时直接返回成功，不重复记账；
- batch 确认记录 TTL 建议 ≥ 7 天（覆盖 exporter 最长重试窗口）；
- **不要**跨 batch 用行内容指纹去重：同一毫秒、同会话、同模型的两次真实调用可能产生完全相同行，内容去重会漏记。

## 6. 行映射

复用 `providers/dsh/telemetrylog.js` 现有算法：

```text
ts                = rows[].time 规范化后的 epoch ms
date              = localDayStr(ts)   // 北京时区口径
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
- ingest 入口应走与文件扫描相同的 `usageDaily` / `usageDailyCost` 提交路径，避免两套汇总逻辑。

## 7. 与 localLog 的共存

- exporter 默认从文件**当前 EOF** 开始 tail，不推历史；
- 因此：开启 push 之前的历史仍由现有文件扫描补录；
- TokenMonitor 首次收到某 `sourceId` 的成功 batch 后，记录 `ingestStartedAt`；
- 对已进入 push 模式的遥测根目录，停止日常 `localLog` 轮询，但保留诊断页的「手动重扫/回填」入口；
- 未启用 exporter 的 dsh 实例继续走现有 `localLog`，行为不变。

## 8. 安全

- ingest token 与 MCP 只读 token 分离；
- 路由只绑定 `127.0.0.1`（本机）或按部署显式配置监听地址；
- `cwd` 可能包含路径信息，只发送到用户配置的受信端点；
- 日志不打印 token，不打印完整 body（可打印 batchId/行数）。

## 9. 非目标（本期不做）

- TokenMonitor 反向向 dsh 下发配置；
- dsh 多进程同时写同一遥测文件的一致性（沿用现有单实例假设）；
- 通用多租户/团队看板的后端扩容。

## 10. 验收清单

- [ ] `POST /api/v1/dsh/usage` 可接收合法 batch 并落库；
- [ ] 重复 batch 返回 `duplicates` 且不重复记账；
- [ ] 400/401/413/429/5xx 均有明确响应；
- [ ] 与文件扫描产生的 `UsageRecord` 映射结果一致（用同一批 JSONL 行做对照测试）；
- [ ] 开启 push 后不再被 localLog 轮询重复计数；
- [ ] 未开启 push 的 dsh 仍可被文件扫描正常监控。
