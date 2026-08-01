# 内容自适应缩放层设计

日期:2026-08-01
状态:已获用户批准

## 背景与问题

DeepSeek Monitor(Electron 桌面小窗)窗口缩小时,统计卡大数字被截断(如 `¥15.23` 显示成 `¥15.2`),布局不优雅。

根因(三层叠加):

1. `.fee-card-value` 基础字号固定 22px(`components.css`),且在 `card` 预设下被 `layout.css` 静态放大到 38px;
2. `.grid-stack-item-content { overflow: hidden }` 把溢出的数字直接裁掉;
3. 布局是格数驱动的(GridStack 12 列),字体是预设名驱动的静态 px,两者之间没有桥梁——卡片缩到多小,38px 都不变。窗口最窄 380px 时单卡内容宽约 85–89px,38px 字号的 `¥15.23` 需要 120px 以上,必然溢出。

## 目标

修好现有机制:保留 GridStack 自由布局,让以下三类内容随容器宽度自适应:

- 统计卡大数字(余额/今日消耗/缓存命中率)
- 所有组件文字(卡片标题/副标题、图表标题、底部状态栏)
- 图表 canvas 内的坐标轴/数值标注(ECharts)

## 非目标

- 不改 GridStack 布局体系、640px 断点(`layout-policy.js`)、预设表(`component-registry.js`)
- 不改 Ctrl+滚轮 zoomFactor 体系(`app.js` / `src/main/index.js`)
- 不做 transform scale 整体缩放
- 不调整窗口 min/max 尺寸约束(380×200 / 2400×1600)

## 方案:CSS 容器查询为主 + ECharts 字号档位

DOM 文字用 container queries + `cqw` / `clamp()`,声明式、零 JS、性能好;图表 canvas 标注 CSS 管不到,在 ECharts resize 时按宽度档位重算。

### 1. CSS 容器查询(`src/renderer/css/layout.css`、`components.css`)

- `.grid-stack-item-content`(或 `.component-surface`)声明 `container-type: size`,每个组件成为独立容器。
- `.fee-card-value`:删除 `[data-layout-preset="card"]` 下固定 38px 的放大规则,改为 `font-size: clamp(14px, 24cqw, 38px)` 量级(实施时按实测微调);保留 `white-space: nowrap`,加 `text-overflow: ellipsis` 兜底。
- 卡片标题/副标题(充值、赠金、tokens 等)、图表标题、底部状态栏:同样改为 `clamp()` + `cqw`,各自定上下限。
- `overflow: hidden` 保留作为最后兜底,正常情况下不再触发。

### 2. 图表标注(ECharts)

- 在现有 `scheduleChartResize()` 调用链(`src/renderer/js/app.js`)上,resize 时按图表容器宽度分档(如 <400 / 400–800 / >800)重算 `axisLabel.fontSize`、`grid` 边距等 option,随 `chart.resize()` 一起生效。
- 档位计算做成纯函数,便于单元测试。

### 3. 边界条件

- 最窄 380px:所有 `clamp()` 下限 ≥12px,保证可读。
- 最宽 2400px:`clamp()` 上限防止文字虚胖。
- 实施前确认项目 Electron 版本的 Chromium ≥105(container queries 支持);若不支持,降级为 JS fit-text(仅处理卡片数字,填入 `fee-cards.js` 现有的空 `resize` hook)。

## 测试

- 现有静态测试(`scaling-and-session-static`、`layout-controller-static`、`layout-policy`、`reflow-animator` 等)必须保持通过。
- 新增静态测试:断言 `.fee-card-value` 不再被固定 38px 覆盖、使用 `clamp()`;图表字号档位纯函数的单元测试。

## 关键文件

- `src/renderer/css/layout.css` — GridStack/preset 样式,38px 放大规则所在
- `src/renderer/css/components.css` — `.fee-card-value` 基础样式
- `src/renderer/css/main.css` — 骨架、状态栏
- `src/renderer/js/app.js` — `scheduleChartResize()`、resize 监听
- `src/renderer/js/components/fee-cards.js` — 统计卡渲染,空 `resize` hook(降级方案挂点)
