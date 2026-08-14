# DSH Token 消耗监测接口 — 设计文档

- 日期:2026-08-14
- 状态:主体设计已确认;2026-08-15 提交前修复采用方案 A(后端可稳定提交,前端平台入口仍由 Kimi 完成)
- 涉及仓库:`D:\Deepseek_Harness`(DSH,新增遥测输出)、`D:\Deepseek_Monitor`(Monitor,新增消费端)
- 背景:当前 Monitor 只统计 DeepSeek / Codex / Kimi 三平台用量,无法展示 DeepSeek Harness(DSH)自身的 token 消耗速率与实时统计。本设计为 DSH 增加一个轻量、稳定的消耗监测接口(未压缩 JSONL 遥测),并在 Monitor 主进程接入现有统计管线;前端面板由 Kimi 另行完成。

## 1. 目标与非目标

**目标**

1. DSH 运行期间,把每次模型请求的最终 usage 以一行 JSON 追加写入 `$DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl`(未压缩、按天轮转)。
2. Monitor 新增 `dsh` provider,tail 该遥测文件,把 DSH 用量并入现有每日聚合(`usageDaily`)、热力图与 Token 速度卡(provider id `dsh`)。
3. Monitor 按模型为 DSH 用量计算费用(¥),费用卡与趋势图自动涵盖。
4. 全部改动默认开启、可配置关闭;Monitor 只把 DSH 费用并入现有费用趋势图,不新增 DSH 平台入口或独立面板(平台入口与面板由 Kimi 完成)。

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
- 默认根:`~/.dsh/telemetry`;检测 `$DSH_HOME` 环境变量(存在时用 `$DSH_HOME/telemetry`);设置项 `providers.dsh.telemetryRoot` 可覆盖(与 Codex 的 `localLogRoot` 模式一致)。`DSH_HOME` 与自定义根均做 `~`/`~/`/`~\` 前缀展开并 `path.resolve` 绝对化,与 DSH 生产者 `resolveDshHome`(expandHomePath + resolve)语义一致,避免波浪号/相对路径时两边指向不同目录、静默无数据。
- 游标:`localLogCursors.dsh`,按文件完整路径这一稳定身份续扫;扫描完成快照后提交游标,失败不提交(沿用 Codex 原子模式)。目录或单个文件暂时消失、不可读时保留既有游标,不得仅因本轮枚举未发现文件就 GC;只有用户触发全量历史重扫时显式清空 DSH 游标。这样文件恢复后从原 offset 续扫,不会把仍保留的日聚合重复累加。游标规模按遥测日线性增长(每日一个小对象),以可忽略的存储换取 exactly-once 恢复语义。
- 行解析严格执行 schema v1,不做 `Number(...)` 类型强制转换:`time` 必须是安全整数毫秒;`sessionId` 必须是非空字符串;`inputTokens` / `outputTokens` 必须显式存在且为非负安全整数;`cacheReadTokens` / `cacheWriteTokens` 仅在缺失时默认为 0,只要出现就必须是非负安全整数;可选 `model` / `cwd` 出现时必须是字符串。JSON.parse 失败、`v !== 1` 或任一字段非法时跳过整行并计入对应诊断;**绝不伪造时间戳或会话 id**。
- 截断尾行(DSH 崩溃导致最后一行不完整)由 Monitor 容忍:丢弃未闭合行并计入 `truncatedTail` 诊断(每个受影响文件每轮至多一次);补齐换行后该行恰好重读一次。
- Provider 暴露 `localLogRoot({ store })`(watch service 的接入契约),返回解析后的遥测根目录;不存在时 watch service 自动标记 `missing-root`,不报错。

### 4.3 字段映射与聚合

遥测行 → `UsageRecord`:

| UsageRecord 字段 | 来源 |
| --- | --- |
| provider | `'dsh'` |
| date | `time` 的固定北京时间日期 |
| model | 行 model(缺失时用 `'unknown'`) |
| inputTokens | `inputTokens + cacheWriteTokens`(缓存写按输入计费) |
| outputTokens | `outputTokens` |
| cachedTokens | `cacheReadTokens` |
| cost / currency | pricing.js 按模型单价计算,`CNY` |

聚合沿用 `rollupDaily`(provider + date 粒度,跨模型求和),热力图与跨平台堆叠图自然涵盖 dsh。

### 4.4 费用(pricing.js)

- `src/main/pricing.js` 增加按事件时间选择的 DSH 单价表,字段:`input` / `output` / `cacheHit`(¥ / 1000 tokens,与现有 PRICING 同单位)。费用按**原始遥测四桶**计算:`cost = input×input + output×output + cacheRead×cacheHit + cacheWrite×input`(与 4.3 的 UsageRecord 映射独立,不重复计费)。`getDshModelPrice(model, timeMs)` 与 `calcDshCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, timeMs)` 必须由遥测行的规范化 `time` 驱动,不得用扫描发生时刻代替,从而保证历史重扫价格稳定。
- 北京时间 2026-08-17 00:00 前按官方当前价:Flash 缓存命中/未命中输入/输出分别为 ¥0.02/¥1/¥2 每百万 token;Pro 分别为 ¥0.025/¥3/¥6 每百万 token。
- 北京时间 2026-08-17 00:00 起采用官方峰谷价。高峰区间为 `[09:00,12:00)` 与 `[14:00,18:00)`,其余为空闲时段:Flash 空闲 ¥0.05/¥1.5/¥4.5、高峰 ¥0.10/¥3/¥9;Pro 空闲 ¥0.15/¥4.5/¥13.5、高峰 ¥0.30/¥9/¥27(顺序均为缓存命中/未命中输入/输出,单位为每百万 token)。北京时间换算必须使用固定 UTC+8,不依赖宿主机时区或 DST。
- 以上数值以 2026-08-15 复核的 DeepSeek 官方定价页([模型 & 价格 | DeepSeek API Docs](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/))为准。DSH 仅识别官方列出的 `deepseek-v4-flash*` / `deepseek-v4-pro*`;既有通用 `PRICING` / `calcCost` 的 legacy reasoner 行为不改。
- 该表**不设默认行**:未收录模型(含缺失 model 回退的 `'unknown'`)查无价格 → `calcDshCost` 记 0,`parseTelemetryLine` 计 `unknownModel` 诊断 +1(不阻塞聚合),避免未知/未来模型静默按 pro 单价错估。

### 4.5 Token 速度卡

- `src/main/core/token-speed-tracker.js` 的 `PROVIDER_IDS` 增加 `'dsh'`(10 秒采样间隔、6 小时历史、8 档窗口自动覆盖)。
- 数据流:local-log 管线把 dsh 日聚合写入 store 的 usageDaily → `token-speed-runtime.js` 按 provider 读取当日 `row.total` 喂给 tracker(与现有平台同一条链);dsh 的 `row.total` = 当日所有记录 `inputTokens + outputTokens + cachedTokens` 之和。tracker 自身无需为 dsh 做任何改动(PROVIDER_IDS 之外的逻辑全部复用)。

### 4.6 注册与 IPC

- `src/main/providers/registry.js` 注册 `dsh` provider;registry 驱动的枚举(scheduler、local-log-watch-service、诊断)自动涵盖。
- 不新增 IPC 通道;`get:dashboard` 为 `pid === 'dsh'` 增加分支:`src/main/core/dsh-dashboard.js`(纯函数)把 store 键 `usageDaily` / `usageDailyCost` 的 `dsh:` 前缀日行聚合为与 deepseek stats 同构的 `{ tokenDaily, costDaily, aggregate }`,再经 `buildCurvePoints` 生成 `curveToken` / `curveCost`。热力图、跨平台堆叠、速度卡继续由 usageDaily 既有通道携带 dsh 数据。
- **渲染层费用通道**:cost-line(费用增长趋势)用 `renderer/src/lib/curve-merge.js` 的 `mergeCurves` 把 deepseek 平台 `curveCost` 与 dsh `curveCost` 按日合并(同日增量求和、按时间升序重算累计)后渲染;deepseek 未登录(无 curveCost)时单 dsh 曲线也可正常显示。
- **前后端边界**:渲染层硬编码平台列表(ProviderBar、TokenSpeedCard 下拉、TokenHeatmap 平台选择、设置页开关)。主进程侧只保证数据就绪与 `PROVIDER_IDS` 扩展;上述渲染层列表加入 `'dsh'` 由 Kimi 在前端工作中完成(交付时给出确切文件清单:`renderer/src/components/ProviderBar.jsx`、`renderer/src/lib/token-speed-chart.js`、`renderer/src/components/TokenHeatmap.jsx`、设置页相关文件)。
- **settings 载荷瘦身**:`sanitizeSettings` 显式剥离 `usageDaily`/`usageDailyCost` 大数据键——用量/费用聚合只经专用 IPC(`get:heatmap`/`get:dashboard`)提供给渲染层,不随 `get:settings`/`settings:loaded` 每 60s 整库广播。
- **保留窗口一致性**:`pruneUsageDaily` 在启动和 `data.historyDays` 更新时,用同一个北京时间窗口同时过滤 `usageDaily` 与 `usageDailyCost`;费用行不得比对应 token 日行保存更久。函数原有返回值继续表示被删除的 `usageDaily` 行数,避免改变既有调用契约。
- `src/main/aggregator.js` / `src/main/ipc.js` 仅做 provider id 枚举扩展(如已有硬编码列表)。

## 5. 错误处理

| 位置 | 场景 | 行为 |
| --- | --- | --- |
| DSH 遥测 | 目录创建 / 追加写失败 | fail-soft,logger.warn,不影响会话 |
| DSH 遥测 | 文件句柄失效 | 重置句柄,下次重开 |
| DSH 遥测 | 设置关闭 | 不订阅、不写文件 |
| Monitor | 行损坏 / v≠1 / 字段非法 | 跳过该行,诊断计数 +1 |
| Monitor | 遥测目录/单个文件不存在或暂时不可读 | 视为本轮无新数据,不报错且保留既有游标;恢复后从原 offset 续扫 |
| Monitor | 游标提交失败 | 快照路径整体替换 store(原子);回退路径单次多键 `set(object)` 一次落盘、失败单次还原三键(usageDaily/usageDailyCost/游标)——不存在三次独立写之间的崩溃窗口;游标边界处被重读的最后一行由 `lastEventFingerprint` 指纹兜底去重 |
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

1. 遥测行解析:正常行、v 不匹配、坏 JSON、缺 model、缺/空 sessionId、字符串/null/布尔 token、缺失可选 cache 桶、负数或超安全整数 token。
2. 字段映射:inputTokens 含 cacheWrite、cachedTokens=cacheRead、cost 按单价表。
3. 游标续扫:跨轮次增量、文件追加只读新行;目录和文件临时移走再恢复不清游标、不重复累计;重扫去重(指纹)。
4. 根目录解析:默认 ~/.dsh/telemetry、DSH_HOME 环境变量、settings 覆盖优先级;测试只用宿主平台原生路径构造,并在 Windows/POSIX 分别通过。
5. 费用:2026-08-17 生效边界前后、09:00/12:00/14:00/18:00 峰谷边界、Flash/Pro 四桶费用均精确;未知模型 cost=0 + 诊断;历史重扫按事件时间而非扫描时间计价。
6. 保留期:`pruneUsageDaily` 用同一窗口清理 `usageDaily` / `usageDailyCost`,且不触碰游标和其他设置。
7. 曲线合并:按固定北京时间日键合并并用 UTC 午夜作为稳定点时间;至少在 UTC+8 与 America/Los_Angeles 两种宿主时区得到相同结果。
8. token-speed-tracker 含 'dsh' 的状态初始化与采样。

## 7. 生效方式与边界

1. DSH 侧改动需 `pnpm build` 并重启 DSH 实例后生效;重启前的历史用量不回溯(后续可选)。
2. Monitor 重启后开始采集;首次扫描读当日文件全部行,次日轮转后旧日期文件只读增量。
3. 模型名透传 DSH 原始字符串;Monitor 不做改名映射。
4. 遥测文件由 DSH 独占追加;Monitor 只读,不修改、不清理(文件清理策略后续可选)。

### 7.5 已知边界(实现后记录)

1. **时区口径**:遥测文件名按 DSH 机器**本地时区日期**(writer.dayStamp);Monitor 聚合日键按**固定北京时间**(`localDayStr`)。非 UTC+8 机器上,文件内某日的行可能归入相邻北京日桶——无数据丢失(每行只读一次、按 `time` 归因),仅文件名日期与聚合日可能差一天。
2. **时钟前跳**:`normalizeTimestampMs` 拒绝 `time > Monitor 当前时间 + 24h` 的行(计 `invalidTimestamp` 诊断)。DSH 与 Monitor 异机且 DSH 时钟超前超过一天时,该行被丢弃。
3. **单实例写入假设**:DSH writer 每次 `appendFile` 重开文件,Windows 跨进程追加不保证单行原子;假定 `$DSH_HOME` 由单个 DSH 实例独占写入(多实例共享目录可能产生行交错,消费端按坏行丢弃并计诊断)。
4. **整数安全**:消费端用 `Number.isSafeInteger` 校验 token 四桶(≥2^53 整行丢弃);DSH 生产端 schema 与消费端对齐(超安全整数范围的行生产端即拒绝,不产生"生产放行、消费拒绝"的不一致)。
5. **指纹格式含 sessionId**:`eventFingerprint = sha256(ISO(time) \0 sessionId \0 model \0 四桶)`。指纹格式变更会使旧游标的 `lastEventFingerprint` 失效一次(升级瞬间若发生回放,衔接处每文件重发一行);本分支未发布、无既有数据,实际影响为零。
6. **曲线日键**:`renderer/src/lib/curve-merge.js` 复用渲染端 `beijingDayKey`,输出点使用 `Date.UTC(year, month-1, day)`;不得使用宿主本地 `getFullYear/getMonth/getDate` 或本地午夜构造,避免 UTC-时区把 UTC 午夜点归入前一天。

## 8. 验收标准

1. DSH 实例重启后,每完成一次模型请求,`$DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl` 新增一行,字段与 3.3 表一致;跨天自动切换新文件;settings 关闭后不再写入。
2. Monitor 启动后(后端验收):store 的 usageDaily 出现 provider `dsh` 记录;日聚合 / 热力图 / 跨平台堆叠的 IPC 数据包含 dsh;token-speed-tracker 快照含 `dsh` 序列且窗口计算正常;费用趋势数据含 dsh 费用。渲染层平台下拉与卡片(验收标准属 Kimi 前端工作,不在本 spec 范围)。
3. `npm test`(Monitor)与 DSH 新包 vitest 全绿;既有测试无回归。
4. 遥测文件不含任何 prompt/工具文本(隐私验收)。
