# DSH Token 消耗监测接口 — 设计文档

- 日期:2026-08-14
- 状态:已与用户逐节确认,待评审
- 涉及仓库:`D:\Deepseek_Harness`(DSH,新增遥测输出)、`D:\Deepseek_Monitor`(Monitor,新增消费端)
- 背景:当前 Monitor 只统计 DeepSeek / Codex / Kimi 三平台用量,无法展示 DeepSeek Harness(DSH)自身的 token 消耗速率与实时统计。本设计为 DSH 增加一个轻量、稳定的消耗监测接口(未压缩 JSONL 遥测),并在 Monitor 主进程接入现有统计管线;前端面板由 Kimi 另行完成。

## 1. 目标与非目标

**目标**

1. DSH 运行期间,把每次模型请求的最终 usage 以一行 JSON 追加写入 `$DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl`(未压缩、按天轮转)。
2. Monitor 新增 `dsh` provider,tail 该遥测文件,把 DSH 用量并入现有每日聚合(`usageDaily`)、热力图与 Token 速度卡(provider id `dsh`)。
3. Monitor 按模型为 DSH 用量计算费用(¥),费用卡与趋势图自动涵盖。
4. 全部改动默认开启、可配置关闭;不新增渲染层 UI 代码(面板由 Kimi 完成)。

**非目标**

- 不回溯重建遥测启用前的历史用量(zstd 压缩会话日志的重建列为后续可选工作)。
- 不改动 DSH 现有 token-meter 投影、会话日志格式或任何现有包。
- 不在 Monitor 新增自定义 IPC 通道;复用现有 daily/heatmap/speed 数据通道。
- 不对 DSH 模型名做改名映射,透传原始 model 字符串。

## 2. 总体架构与数据流

```
DSH 运行实例                       DSH 数据目录                    DeepSeek Monitor
┌───────────────────┐   append    ┌────────────────────────┐  tail  ┌────────────────────────────────┐
│ session/event     │ ─────────▶  │ $DSH_HOME/telemetry/   │ ─────▶ │ providers/dsh(ProviderAdapter) │
│  assistant/message│   每请求    │ usage-YYYY-MM-DD.jsonl │  游标  │  → usageDaily 聚合 + 费用(pricing)│
│  (data.usage)     │   一行      │ (未压缩 JSONL,纯数字)   │  监视  │  → token-speed-tracker('dsh')   │
└───────────────────┘             └────────────────────────┘        │  → 现有 IPC 通道 → Kimi 前端面板 │
                                                                    └────────────────────────────────┘
```

- 遥测行只含数字、模型名、会话 id、项目目录,**不含任何 prompt / 工具文本**,无隐私风险。
- 费用由 Monitor 按模型单价计算,遥测文件不写金额。

## 3. DSH 侧:新包 `@deepseek-ai/dsh-usage-telemetry`

### 3.1 包结构

新建 `packages/telemetry/usage-telemetry`,与 token-meter 同层,不动任何现有包:

```
packages/telemetry/usage-telemetry/
  src/
    index.ts        # cordis Service:订阅 session/event,组装行,调 writer
    schema.ts       # 行 schema(v1,zod)+ 字段定义
    writer.ts       # 追加写、按天轮转、fail-soft
    settings.ts     # 开关:ctx.settings 注册 usage-telemetry 命名空间
  tests/
    usage-telemetry.spec.ts
```

### 3.2 事件订阅与计数口径

- 订阅 `ctx.on('session/event')`,仅处理 `assistant/message` 且 `event.data.usage !== undefined` 的事件。
- 这是每请求的最终 usage 样本,与 token-meter 的计数口径一致;`assistant/chunk` 的 usage 块是早期样本,**不写遥测**,避免重复计数。
- 模型名:维护每会话最近一次 `request/header` 事件的 `data.header.config.model`(`request/header` 数据形如 `{ header: EpochHeader, reason }`,`header.config` 为 `LlmCallConfig`);该事件缺失或 config.model 为空时 model 字段省略(可空)。
- 子代理场景天然覆盖:进程内子代理的 usage 折叠进父会话日志,独立进程子代理(Dsh CLI 子进程)拥有自己的会话与遥测行。

### 3.3 行格式(schema v1)

每请求一行 JSON,严格键序:

```json
{"v":1,"time":1786641087069,"sessionId":"session-64e898c4-3520-4f4e-aa1d-a4f344217337","cwd":"D:\\Deepseek_Monitor","model":"deepseek-v4-pro","inputTokens":1404,"outputTokens":1089,"cacheReadTokens":46592,"cacheWriteTokens":0}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| v | int | 行 schema 版本,恒为 1;消费者对未知版本整行丢弃 |
| time | int(ms) | 事件 `time`(会话事件时间戳) |
| sessionId | string | 会话 id |
| cwd | string | 会话工作目录(identity 中的 cwd;缺失时省略) |
| model | string? | 该请求所用模型;未知时省略 |
| inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens | int ≥ 0 | 与 token-meter 四桶一致;cacheRead/cacheWrite 缺失按 0 |

### 3.4 文件与轮转

- 根目录:`$DSH_HOME/telemetry`(经 `resolveDshHome` 解析,默认 `~/.dsh`;`DSH_HOME` 环境变量生效)。
- 文件名:`usage-YYYY-MM-DD.jsonl`(本地时区日期)。
- 轮转:懒打开当前日期文件句柄并缓存;写入前检查日期,跨天则关闭旧句柄、打开新文件。目录不存在时创建。
- 原子性:每次追加一行(单次 `appendFile` 带换行);不做跨行原子保证——消费端容忍截断尾行(Monitor 丢弃未闭合行)。

### 3.5 开关与配置

- 默认开启;通过 `ctx.settings.register('usage-telemetry', schema, { enabled: true })` 暴露到 settings.yaml(与现有命名空间约定一致,如 `agent-default-model`),写入 `usage-telemetry:\n  enabled: false` 时组件不写任何文件。
- 关闭态下不订阅 session/event(零开销)。
- 其余参数(行 schema、轮转策略)不进设置面,保持接口稳定。

### 3.6 可靠性与失败模式

- 所有写入 fail-soft:失败仅 `ctx.logger.warn`,绝不影响会话流程或投掷。
- 写入异常连续失败时退避(单次重试 + 警告),文件句柄出错时重置并重建。
- 组件自身异常由 cordis 隔离,不传播到会话事件路径。

### 3.7 bundle 注册

- 在 `packages/bundle/web-app/cordis.yml`(或对应 patch 文件)中注册该插件,即本机正在运行的 DSH 实例形态。
- DSH 需重新构建并**重启实例**后遥测才开始写入。

## 4. Monitor 侧:新 provider `dsh`

### 4.1 文件结构

```
src/main/providers/dsh/
  index.js          # ProviderAdapter 入口(id 'dsh',displayName 'DeepSeek Harness')
  telemetrylog.js   # 行解析、事件指纹、根目录解析、readLocalLog 扫描
```

`capabilities`:`{ balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false }`;不实现 fetchBalance/fetchUsage/fetchQuota。

### 4.2 遥测文件读取

- 复用 `src/main/core/locallog.js` 的 `scanCandidateBatch` / `scanFileBatch` / `rollupDaily` / `walkFiles` 辅助。
- 默认根:`~/.dsh/telemetry`;检测 `$DSH_HOME` 环境变量(存在时用 `$DSH_HOME/telemetry`);设置项 `providers.dsh.telemetryRoot` 可覆盖(与 Codex 的 `localLogRoot` 模式一致)。
- 游标:`localLogCursors.dsh`,按稳定文件名身份(usage-YYYY-MM-DD.jsonl 的完整 basename 即稳定身份)续扫;扫描完成快照后提交游标,失败不提交(沿用 Codex 原子模式)。
- 行解析:JSON.parse 失败、`v !== 1`、`time` 非有限数、token 字段非非负整数时,跳过该行并计入诊断;**绝不伪造时间戳**。
- 截断尾行(DSH 崩溃导致最后一行不完整)由 Monitor 容忍:丢弃未闭合行并计入诊断。
- Provider 暴露 `localLogRoot({ store })`(watch service 的接入契约),返回解析后的遥测根目录;不存在时 watch service 自动标记 `missing-root`,不报错。

### 4.3 字段映射与聚合

遥测行 → `UsageRecord`:

| UsageRecord 字段 | 来源 |
| --- | --- |
| provider | `'dsh'` |
| date | `time` 的本地时区日期 |
| model | 行 model(缺失时用 `'unknown'`) |
| inputTokens | `inputTokens + cacheWriteTokens`(缓存写按输入计费) |
| outputTokens | `outputTokens` |
| cachedTokens | `cacheReadTokens` |
| cost / currency | pricing.js 按模型单价计算,`CNY` |

聚合沿用 `rollupDaily`(provider + date + model 粒度),热力图与跨平台堆叠图自然涵盖 dsh。

### 4.4 费用(pricing.js)

- `src/main/pricing.js` 增加 `dsh` 模型单价表,字段:`input` / `output` / `cacheHit`(¥ / 1000 tokens,与现有 PRICING 同单位)。费用按**原始遥测四桶**计算:`cost = input×input + output×output + cacheRead×cacheHit + cacheWrite×input`(与 4.3 的 UsageRecord 映射独立,不重复计费)。
- 表结构与现有 deepseek 段一致;单价在实现时以 DeepSeek 官方定价页([模型 & 价格 | DeepSeek API Docs](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/))最新值为准填入。
- 已知 2026-08-17 起 DeepSeek 生效峰谷定价([DoNews 报道](https://www.donews.com/news/detail/4/6670406.html));表结构预留 `offPeakInput` / `offPeakOutput` / `offPeakCacheHit` 可选列(缺省时按标准价),实现时若官方页已更新则直接填入峰谷值。
- 未收录模型回退到该表默认行;查无默认行时 cost 记 0 且诊断计数 +1(不阻塞聚合)。

### 4.5 Token 速度卡

- `src/main/core/token-speed-tracker.js` 的 `PROVIDER_IDS` 增加 `'dsh'`(10 秒采样间隔、6 小时历史、8 档窗口自动覆盖)。
- 数据流:local-log 管线把 dsh 日聚合写入 store 的 usageDaily → `token-speed-runtime.js` 按 provider 读取当日 `row.total` 喂给 tracker(与现有平台同一条链);dsh 的 `row.total` = 当日所有记录 `inputTokens + outputTokens + cachedTokens` 之和。tracker 自身无需为 dsh 做任何改动(PROVIDER_IDS 之外的逻辑全部复用)。

### 4.6 注册与 IPC

- `src/main/providers/registry.js` 注册 `dsh` provider;registry 驱动的枚举(scheduler、local-log-watch-service、诊断)自动涵盖。
- 不新增 IPC 通道:usageDaily、热力图、速度卡、费用数据的现有通道自然携带 dsh 数据。
- **前后端边界**:渲染层硬编码平台列表(ProviderBar、TokenSpeedCard 下拉、TokenHeatmap 平台选择、设置页开关)。主进程侧只保证数据就绪与 `PROVIDER_IDS` 扩展;上述渲染层列表加入 `'dsh'` 由 Kimi 在前端工作中完成(交付时给出确切文件清单:`renderer/src/components/ProviderBar.jsx`、`renderer/src/lib/token-speed-chart.js`、`renderer/src/components/TokenHeatmap.jsx`、设置页相关文件)。
- `src/main/aggregator.js` / `src/main/ipc.js` 仅做 provider id 枚举扩展(如已有硬编码列表)。

## 5. 错误处理

| 位置 | 场景 | 行为 |
| --- | --- | --- |
| DSH 遥测 | 目录创建 / 追加写失败 | fail-soft,logger.warn,不影响会话 |
| DSH 遥测 | 文件句柄失效 | 重置句柄,下次重开 |
| DSH 遥测 | 设置关闭 | 不订阅、不写文件 |
| Monitor | 行损坏 / v≠1 / 字段非法 | 跳过该行,诊断计数 +1 |
| Monitor | 遥测目录不存在 | 视为无数据,不报错 |
| Monitor | 游标提交失败 | 沿用 Codex 原子提交模式,下次重扫(事件指纹去重防双计) |
| Monitor | 模型单价缺失 | cost 记 0,诊断计数 +1,不阻塞聚合 |

事件指纹:规范化 time + sessionId + model + 四桶数值做 SHA-256,重扫去重(含会话与模型身份,避免不同会话同毫秒同桶的行被误去重)。

## 6. 测试策略(TDD,先写测试)

**DSH(`packages/telemetry/usage-telemetry/tests/`)**

1. 给定 assistant/message(带 usage)事件流 → 写出对应行,字段与口径正确。
2. assistant/chunk usage 块不产生行;无 usage 的 assistant/message 不产生行。
3. model 取自最近 request/header;缺失时省略。
4. 跨天轮转:日期变化后写入新文件,旧句柄关闭。
5. `enabled: false` 时无订阅、无文件。
6. 写失败 fail-soft:会话事件路径不受影响。
7. 截断尾行由 Monitor 侧容忍(见 Monitor 测试)。

**Monitor(`test/`,node --test)**

1. 遥测行解析:正常行、v 不匹配、坏 JSON、缺 model、负数 token。
2. 字段映射:inputTokens 含 cacheWrite、cachedTokens=cacheRead、cost 按单价表。
3. 游标续扫:跨轮次增量、文件追加只读新行;重扫去重(指纹)。
4. 根目录解析:默认 ~/.dsh/telemetry、DSH_HOME 环境变量、settings 覆盖优先级。
5. 费用:已知单价下 cost 精确;未知模型回退默认行;无默认行 cost=0 + 诊断。
6. token-speed-tracker 含 'dsh' 的状态初始化与采样。

## 7. 生效方式与边界

1. DSH 侧改动需 `pnpm build` 并重启 DSH 实例后生效;重启前的历史用量不回溯(后续可选)。
2. Monitor 重启后开始采集;首次扫描读当日文件全部行,次日轮转后旧日期文件只读增量。
3. 模型名透传 DSH 原始字符串;Monitor 不做改名映射。
4. 遥测文件由 DSH 独占追加;Monitor 只读,不修改、不清理(文件清理策略后续可选)。

## 8. 验收标准

1. DSH 实例重启后,每完成一次模型请求,`$DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl` 新增一行,字段与 3.3 表一致;跨天自动切换新文件;settings 关闭后不再写入。
2. Monitor 启动后(后端验收):store 的 usageDaily 出现 provider `dsh` 记录;日聚合 / 热力图 / 跨平台堆叠的 IPC 数据包含 dsh;token-speed-tracker 快照含 `dsh` 序列且窗口计算正常;费用趋势数据含 dsh 费用。渲染层平台下拉与卡片(验收标准属 Kimi 前端工作,不在本 spec 范围)。
3. `npm test`(Monitor)与 DSH 新包 vitest 全绿;既有测试无回归。
4. 遥测文件不含任何 prompt/工具文本(隐私验收)。
