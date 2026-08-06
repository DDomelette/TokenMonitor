# 历史用量同步 + 热力图视图改版 设计

日期：2026-08-07
状态：设计已评审通过（方案 A)

## 背景与问题

用户反馈四个问题，经代码摸底确认根因：

1. **DeepSeek 6 月及更早数据缺失**。官方用量 API 按自然月查询（`GET /api/v0/usage/amount|cost?month=&year=`)，应用已有逐月回填但 `BACKFILL_MONTHS=6` 封顶；且 `pruneUsageDaily` 按"历史保留天数"删除旧 `usageDaily` 键后，`fetchedMonths` 标记不会重置，被删数据永不再抓——永久丢失。
2. **Codex 部分日期缺失**。官方只有额度窗口快照 API，无按日历史；数据全部来自本机 `~/.codex/sessions/**/rollout-*.jsonl` 日志的增量扫描。"日志在但聚合丢了"的部分可通过空游标全量重扫补回；日志本身不覆盖的使用（网页版、其他机器、日志被清理）无法恢复，属固有限制。
3. **与官方 dashboard 对不上（时区）**。应用落盘已是北京日历日（`localDayStr`)，与官方非北京结算口径的错位属固有；要做的是核查并用测试钉死三家的日边界均为北京日。
4. **Kimi 数据完整性未知**。同 Codex，全量重扫 + 核查即可见分晓。

另外用户要求热力图"每周"视图改为参考图的方块堆积样式（每列一周，方块高度 ∝ 当周量，tooltip "X月X日 当周使用了 N Token"),"累计"视图同样改为方块堆积（高度 ∝ 截至该周累计量，列高单调不减，tooltip "截至 X 年 X 月 X 日 当周累计使用 N Token")。

## 方案概览（方案 A)

设置页新增"同步历史数据"按钮，一次完成：DeepSeek 逐月全量回填、Codex/Kimi 本机日志全量重扫、日边界核查；视图改版为独立 PR。用户已确认的形态决策：

- 手动按钮触发（不做启动自动回填、不做命令行脚本）;
- 直接替换现有每周/累计视图，不加切换开关；
- 历史保留天数只提示不擅改。

## PR 划分

- **PR-1 同步历史**：主进程编排器 + 设置页按钮 + 进度反馈 + 清理策略提示 + 测试。
- **PR-2 视图改版**:`TokenHeatmap.jsx` 每周/累计模式重写。与 PR-1 相互独立，可并行。

## PR-1:同步历史

### 组件

**`src/main/core/history-sync.js`（新增，纯逻辑可测）**

```text
syncDeepSeekHistory({ fetchMonth, readStore, writeStore, onProgress, now })
  - fetchMonth(year, month) -> { days: { 'YYYY-MM-DD': {input,cached,output,total}, models } }
  - 从当月起逐月向前:
    - 单月失败 → 重试 1 次,仍失败记录为 failed 并继续
    - 连续 2 个月 days 为空 → 停止探测
    - 硬上限 36 个月
  - 写回:同名 '<deepseek>:<date>' 键以 API 数据直接覆盖(幂等,API 为准),models 明细同覆
  - 更新 providers.deepseek.fetchedMonths
  - 请求节奏:每月 amount+cost 两个接口,月与月之间间隔 ~300ms
  - 返回 { monthsFetched, monthsFailed, earliestDate }

rescanLocalLogs({ provider, scanAll, readStore, writeStore, onProgress })
  - scanAll() 以空游标全量扫描本机日志(复用 codex/kimi locallog 的解析与 rollupDaily)
  - 同名 '<provider>:<date>' 键以重扫聚合值覆盖;游标推到最新位置,避免后续增量重复计数
  - 返回 { daysRebuilt, earliestDate }
```

**IPC 接线**(`src/main/ipc.js`)

- `ipcMain.handle('sync:history')`：编排 deepseek + codex + kimi 三路（deepseek 未登录则跳过并在结果中注明），进度经 `win.webContents.send('sync:progress', { stage, detail })` 推送；返回汇总 `{ deepseek: {...}, codex: {...}, kimi: {...} }`。
- 同步完成后调用现有 `broadcastSessionState`/热力图刷新通道，仪表盘立即可见。

**设置页**(`src/renderer/settings-window.html` + 对应 JS，非 React)

- "网络"区块下方新增"历史数据"区块：同步按钮 + 进度文本 + 结果汇总文本。
- 同步中按钮禁用；失败汇总如实展示。

### 清理策略交互

同步完成后比较 `earliestDate` 与 `data.historyDays` 窗口：

- 若最早日期落在窗口外，结果汇总中追加提示："当前历史保留天数为 N 天，早于 X 的数据会被自动清理，建议调到 ≥ M 天"，并提供"一键调整"链接（调用现有设置项，不擅改）。

### 错误处理

- DeepSeek 未登录/会话过期：跳过 deepseek 分支，结果注明"未登录平台，仅同步了本机数据"。
- 网络错误：单月重试 1 次后跳过，计入 failed；不中断整体流程。
- 日志目录不存在/为空：对应平台返回 daysRebuilt=0，不视为错误。

## PR-2:热力图每周/累计视图改版

### 视图规格

- **每周模式**：每列一周（周日起始、北京日历，沿用 `buildSundayWeekTotals`)；列内方块从底向上堆积，方块数 ∝ 当周量；tooltip "X月X日 当周使用了 N 个 Token"(X = 周起始日）。
- **累计模式**：同样方块堆积，方块数 ∝ 从年初截至该周的累计量，列高单调不减；tooltip "截至 X 年 X 月 X 日 当周累计使用 N 个 Token"。
- **规模自适应**:`scale = max(value) / MAX_BLOCKS`,`MAX_BLOCKS = 10`；每列方块数 `Math.round(value / scale)`(value>0 至少 1 块）。
- **样式**：方块沿用主题 primary(#74B8FC）透明度档位；周格子间隔、月份行、图例行保留现有布局。
- **tooltip**：复用现有 portal 到 body 的机制（PR #165 已修），平台明细行逻辑不变。

### 组件改动

- `renderer/src/components/TokenHeatmap.jsx`:`renderWeekly`/`renderCumulative` 重写为统一的方块堆积渲染（可抽一个内部 `renderBlockColumns(values, tipText)`)。
- `renderer/src/lib/heatmap.js`：新增 `blockCount(value, scale)` 纯函数（可测）。
- `renderer/src/styles.css`：新增 `.heatmap-blocks` 等样式，删除/保留但不引用旧的每周格与累计柱样式中不再使用的部分（保留每日模式样式不动）。

## 测试

- `test/history-sync.test.js`:mock `fetchMonth` 验证逐月推进、连续 2 空月停止、36 月硬上限、失败跳过与汇总、覆盖写入幂等；mock scanAll 验证重扫覆盖与游标推进。
- 日边界：注入固定时间戳（如 UTC 2026-06-17T16:30:00Z = 北京 6/18 00:30)，断言聚合键为北京日。
- `blockCount`：规模自适应边界（0、小值、最大值）。
- 视图接线：源码级断言（项目惯例）——方块堆积渲染函数、tooltip 文案、portal 保留。
- 全套 `npm test` 必须通过。

## 已确认的取舍

- DeepSeek 回填探测上限 36 个月、连续 2 空月即停；
- Codex/Kimi 同名键以重扫值覆盖（本机日志为唯一数据源）;
- 官方无 Codex/Kimi 按日历史 API，日志不覆盖的日期不可恢复，不设预期；
- 历史保留天数只提示不擅改；
- 每周口径维持周日起始（与参考图一致）;
- 不加新旧视图切换开关。
