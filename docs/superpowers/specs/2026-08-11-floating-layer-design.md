# 悬浮层统一动作模板(Floating Layer)设计

日期:2026-08-11
状态:已获用户批准(方案 A)

## 背景与问题

主窗口各模块的悬浮层(tooltip / 下拉菜单)目前各自实现定位逻辑:

| 悬浮层 | 现状 |
|---|---|
| model-bar / token-line / cost-line / ProviderBar(ECharts) | 已共用 `windowClampedPosition`(挂 body + 窗口钳制),定义在 `components/ChartWidget.jsx` |
| Token 消耗速度卡片(`lib/token-speed-chart.js`) | 只有 `appendToBody: true`,**未接位置钳制** → ECharts 默认定位使 tooltip 顶出窗口上沿被裁(本次 bug) |
| 热力图 tooltip(`components/TokenHeatmap.jsx`,React) | 自写 `clampTipX`(104px 估算半宽 + 渲染后二次校正)、`r.top < 140` 的 below 翻转 |
| CustomSelect 菜单(`components/CustomSelect.jsx`,React) | 自写 below/drop-up 空间估算,portal 到 body |

目标:把"定位动作模板"收敛为一个纯函数库,四个消费方统一引用;并用静态测试防止未来新模块漏接。

## 方案(A,已批准)

新建 `renderer/src/lib/floating-layer.js` 纯函数模块(无 React / ECharts 依赖,可单测),统一三原语;消费方各自保留交互节奏(延迟/淡出/动画),只替换定位判定。

不采用 React hook 化(方案 B):各模块生命周期与动画时序本就不同,强行统一侵入大、易引入新 bug。

## 组件设计

### `renderer/src/lib/floating-layer.js`(新增)

```js
clampToWindow(x, y, width, height, margin = 8) -> { x, y }
```

- 把左上角坐标 `(x, y)` 钳制进窗口:`[margin, window.innerWidth - width - margin]` × `[margin, window.innerHeight - height - margin]`
- 浮层比窗口还大时,向窗口中间靠拢(Math.max/Math.min 自然退化为 margin 对齐)

```js
resolveVerticalFlip(anchorRect, contentHeight, { gap = 6, margin = 8 } = {}) -> { below, top }
```

- `anchorRect` 为触发元素的 `getBoundingClientRect()` 结果(只读 `top/bottom` 字段)
- 下方可用空间 ≥ `contentHeight + margin`,或上方空间更小时:`{ below: true, top: anchorRect.bottom + gap }`
- 否则:`{ below: false, top: anchorRect.top - gap - contentHeight }`(调用方按 CSS 类决定锚定方式)

```js
echartsWindowPosition(dom) -> (pos, params, tipEl, rect, size) => [x, y]
```

- 现有 `windowClampedPosition` 原样平移:pos 是图表容器坐标,换算页面坐标经 `clampToWindow` 钳制后再减回容器偏移;首选偏移 +14,贴右/下边缘时翻到 -cw-14 / -ch-14

### 消费方改动(4 处)

1. **`lib/token-speed-chart.js`(bug 修复)**:`buildTokenSpeedOption(snapshot, options)` 的 tooltip 增加 `position: echartsWindowPosition(options.dom)`;`components/TokenSpeedCard.jsx` 调用处 options 增加 `dom: chartRef.current`(该处 ref 已存在,现成可用)
2. **`components/ChartWidget.jsx`**:删除本地 `windowClampedPosition` 定义,改为 `import { echartsWindowPosition as windowClampedPosition } from '../lib/floating-layer.js'` 并保留同名 `export`(ProviderBar 现有 import 不变)
3. **`components/TokenHeatmap.jsx`**:`clampTipX` 改用 `clampToWindow`(保留 104px 估算 + useLayoutEffect 二次校正两阶段);`below = r.top < 140` 改用 `resolveVerticalFlip`;延迟/淡出定时器逻辑不动
4. **`components/CustomSelect.jsx`**:`toggle()` 内 below/位置估算改用 `resolveVerticalFlip`(menuHeight 估算保留);portal、外部点击/Escape/滚动收起监听不动

### 导出命名兼容

`ProviderBar.jsx` 从 `ChartWidget.jsx` import `windowClampedPosition`,由 ChartWidget re-export 兼容,不改 ProviderBar。

## 数据流

无状态变化。纯函数在渲染/事件路径上同步调用,输入为 DOM 测量值与 `window.innerWidth/Height`,输出为坐标。

## 错误处理

- `clampToWindow` 对非有限输入(width/height NaN)不做特殊处理——调用方均来自实测 DOM,现有代码同样假设
- `echartsWindowPosition(null)`:`dom` 缺省时按 `{ left: 0, top: 0 }` 处理(沿用现有行为)

## 测试

1. **`test/floating-layer.test.js`(新增,纯函数单测)**:
   - `clampToWindow`:四边界钳制、浮层大于窗口时的 margin 对齐、margin 默认值
   - `resolveVerticalFlip`:下方充足→below、下方不足且上方更宽→向上、gap/margin 参数生效
   - `echartsWindowPosition`:mock dom(`getBoundingClientRect`)与 size,验证坐标换算与钳制
   - 注:`window.innerWidth/Height` 在 node 测试环境需要全局 stub(参考现有测试对浏览器全局的处理方式,如无先例则在测试内 `globalThis.window = { innerWidth, innerHeight }` 注入并 t.after 清理)
2. **静态守卫测试(新增,可并入同一文件)**:扫描 `renderer/src/**/*.{js,jsx}`,凡含 `tooltip:` 的 ECharts option 构建段落,必须同时含 `appendToBody: true` 与 `position:`——新模块漏接即红灯
3. **回归**:`npm test` 全量 0 fail;`npm run build:renderer` 构建通过

## 明确不做

- 不统一各模块显示延迟 / 淡出 / 动画时序
- 不动悬浮层样式与内容(外观、阴影、文案)
- 不动 `src/renderer` 旧 CJS 设置页的 drop-up 逻辑(非卡片悬浮层,自成体系)
- 不改 ProviderBar 的 import 路径(由 ChartWidget re-export 兼容)

## 验证方式

- 单测 + 静态守卫 + 全量回归(上述)
- 手动冒烟:`npm start` 后悬停 Token 消耗速度卡片上沿数据点,tooltip 完整显示在窗口内;热力图首行格子 hover 向下展开;设置面板下拉在窗口底部时向上展开
