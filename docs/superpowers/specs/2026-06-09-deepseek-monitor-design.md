# DeepSeek Monitor — 设计文档

> 日期：2026-06-09  
> 版本：v1.0  
> 状态：已批准

---

## 一、项目概述

一款超轻量级桌面悬浮窗应用，用于实时监控 DeepSeek API 的用量数据。通过本地 HTTP 代理拦截 API 请求，自动聚合 token 消耗、缓存命中率、费用增长等指标，并以模块化组件形式在悬浮窗中展示。

### 核心目标

- **轻量**：内存 < 50MB，打包体积 < 200MB，CPU 空闲 < 0.5%
- **实时**：数据随 API 请求即时更新，曲线图 30 秒粒度采样
- **模块化**：所有展示组件可独立开关、排列、缩放
- **美观**：遵循 DeepSeek 官网设计语言，圆润简洁

---

## 二、技术栈

| 层级 | 技术 | 理由 |
|------|------|------|
| 桌面框架 | Electron 28+ | 悬浮窗 + 托盘 + 代理全部在同一个 JS 进程 |
| 前端 UI | 原生 HTML/CSS/JS + ECharts 5 | 无框架依赖，极轻量 |
| 代理服务器 | Node.js `http` 模块 | 零依赖，流式转发 |
| 数据持久化 | `electron-store` | 加密本地 JSON 存储 |
| 开机自启 | `app.setLoginItemSettings()` | Electron 原生 API |
| 打包 | electron-builder | Windows/macOS 双平台 |

---

## 三、架构

```
┌────────────────────────────────────────────────┐
│              Electron Main Process              │
│                                                 │
│  ┌──────────────┐   ┌───────────────────────┐  │
│  │  HTTP Proxy  │──→│   Data Aggregator     │  │
│  │  (端口7890)  │   │   - 按模型累加消耗     │  │
│  │              │   │   - 计算缓存命中率     │  │
│  │ 转发请求到   │   │   - 时间序列环形缓冲   │  │
│  │ api.deepseek │   │   - 余额定时拉取       │  │
│  └──────────────┘   └───────────┬───────────┘  │
│                                  │ IPC          │
│  ┌───────────────────────────────┴──────────┐  │
│  │        Renderer Process (悬浮窗)          │  │
│  │  ┌────────┐ ┌────────┐ ┌──────────────┐ │  │
│  │  │费用卡片│ │模型柱图│ │Token/费用折线│ │  │
│  │  └────────┘ └────────┘ └──────────────┘ │  │
│  └──────────────────────────────────────────┘  │
│                                                 │
│  ┌──────────────────────────────────────────┐  │
│  │  Tray (系统托盘)  +  Settings Store      │  │
│  └──────────────────────────────────────────┘  │
└────────────────────────────────────────────────┘
```

---

## 四、核心模块

### 4.1 HTTP 代理（Proxy Server）

- 监听 `localhost:7890`（端口可在设置中修改）
- 请求到达 → 保留原始 method/headers/body → 转发到 `api.deepseek.com` → 流式 pipe 响应回客户端
- 从 `/chat/completions` 响应中提取 `usage` 字段：
  ```json
  {
    "prompt_tokens": 1234,
    "completion_tokens": 567,
    "total_tokens": 1801,
    "prompt_cache_hit_tokens": 800,
    "prompt_cache_miss_tokens": 434
  }
  ```
- 非 `/chat/completions` 请求（如 `/user/balance`）直接透传，不做解析
- 延迟目标 < 5ms（纯 pipe，不做完整 body 缓冲）

### 4.2 数据聚合器（Data Aggregator）

**运行时结构：**

```
{
  today: {
    date: "2026-06-09",
    models: {
      "deepseek-v4-pro":    { total_tokens: 8421, prompt_tokens: 5200, completion_tokens: 3221, cache_hit: 4000, cache_miss: 1200 },
      "deepseek-v4-flash":  { total_tokens: 3879, ... },
      "deepseek-reasoner":  { total_tokens: 512,  ... }
    },
    total_cost: 0.0234  // 按模型单价实时计算
  },
  ringBuffer: {
    30s: [...]    // 最近 2880 个采样点（24h）
  },
  balance: {
    total_balance: "86.42",
    granted_balance: "10.00",
    topped_up_balance: "76.42",
    lastFetch: 1717939200000
  }
}
```

**定价配置（硬编码，随 DeepSeek 调价手动更新）：**

```js
const PRICING = {
  'deepseek-v4-pro':    { input: 0.001, output: 0.004, cache_hit: 0.0001 },  // ¥/1K tokens
  'deepseek-v4-flash':  { input: 0.0005, output: 0.002, cache_hit: 0.00005 },
  'deepseek-reasoner':  { input: 0.001, output: 0.004, cache_hit: 0.0001 },
};
```

**缓存命中率公式：**

```
命中率 = 当日累计 prompt_cache_hit_tokens / 当日累计 prompt_tokens × 100%
```

### 4.3 悬浮窗 UI（Renderer）

**窗口属性：**

| 属性 | 默认值 | 可配置 |
|------|--------|--------|
| 尺寸 | 420 × 680 px | 拖拽缩放，有最小限制 |
| 位置 | 屏幕右下角 | 拖拽移动，记忆上次位置 |
| 透明度 | 92% | 滑块 20%~100% |
| 置顶 | 开启 | 开关 |
| 框架 | 无边框 + 16px 圆角 | 固定 |
| 穿透 | 关闭 | 不做鼠标穿透 |

**组件布局引擎：**

- 基于 CSS Grid，自动排列
- 窗口缩放时组件等比缩放（CSS `fr` 单位 + `min-width` 约束）
- 隐藏某组件时，其余组件自动填充空间
- 最小窗口尺寸由所有可见组件的最小尺寸叠加 + 内边距决定

**组件拖拽排序：**

- 长按组件标题区域（200ms）进入拖拽模式
- 拖拽时显示半透明占位阴影，松开后组件插入目标位置
- 排序结果即时持久化到 `electron-store`
- 仅在解锁布局时允许拖拽（设置面板提供「锁定布局」开关，默认开启）
- 实现方案：HTML5 `drag` API + `grid-row` 动态编号

### 4.4 组件详解

#### 组件 A：费用概览卡片（`fee-cards`）

```
三列并排卡片：
  余额卡片：    显示 ¥86.42（总余额），下方小字显示充值余额 / 赠金余额
  今日消耗卡片： 显示 ¥0.0234（今日累计费用），下方小字显示 token 数
  缓存命中卡片： 显示 78.5%（命中率），下方小字显示命中 / 未命中 token
```

- 数据源：余额来自 `GET /user/balance`（每 5 分钟刷新一次），消耗/命中来自代理累加
- 卡片 hover 效果：背景微微变亮 + translateY(-2px)

**用量预警：**

- 余额数字根据剩余额度分三档变色（仅改变余额数字颜色，不影响背景）：
  | 档位 | 条件 | 颜色 | 含义 |
  |------|------|------|------|
  | 正常 | 余额 ≥ ¥20 | `--primary` `#4D6BFE` | 深蓝紫色，与 DeepSeek 主题一致 |
  | 预警 | ¥5 ≤ 余额 < ¥20 | `--warning` `#F59E0B` | 琥珀黄，不刺眼但足够醒目 |
  | 告急 | 余额 < ¥5 | `--error` `#EF4444` | 红色，催促充值 |
- 颜色切换带 300ms 过渡，避免闪烁

#### 组件 B：模型消耗柱状图（`model-bar-chart`）

- 横向柱状图，每个模型一行
- 每行显示：模型名称 | 柱状条（渐变蓝紫色）| token 数值
- 数据排序：按 total_tokens 降序
- 柱状条宽度 = 当前模型 tokens / 最大模型 tokens × 100%（相对比例）

#### 组件 C：Token 增长趋势折线图（`token-line-chart`）

- ECharts 平滑折线图，x 轴为时间，y 轴为 token 数量
- 支持两条线：累计总量（面积填充）+ 增量（柱状图叠加）
- 右上角下拉选择器：`30s | 分钟 | 小时 | 天`
- 30s 维度：最近 15 分钟，30 个数据点
- 分钟维度：最近 1 小时，60 个数据点（对 30s 数据做下采样）
- 小时维度：最近 24 小时，24 个数据点
- 天维度：最近 30 天，30 个数据点（从持久化文件读取）
- ECharts 配置：`animation: false`（避免悬浮窗场景的动画性能开销），增量更新

#### 组件 D：费用增长趋势折线图（`cost-line-chart`）

- 与组件 C 相同结构，y 轴为费用（¥）
- 独立的时间维度选择器
- 花费 = input_tokens × input_price + output_tokens × output_price + cache_hit_tokens × cache_hit_price

### 4.5 设置面板（`settings-panel`）

设置存储引擎：`electron-store`，key 为 `settings`，自动持久化到 `%APPDATA%/deepseek-monitor/config.json`

| 分组 | 设置项 | 类型 | 默认值 |
|------|--------|------|--------|
| 窗口 | 透明度 | slider 20-100 | 92 |
| 窗口 | 始终置顶 | toggle | ON |
| 窗口 | 开机自启 | toggle | OFF |
| 窗口 | 跟随系统主题 | toggle | ON |
| 窗口 | 锁定布局 | toggle | ON |
| 组件 | 费用概览卡片 | toggle | ON |
| 组件 | 模型消耗柱状图 | toggle | ON |
| 组件 | Token 增长趋势 | toggle | ON |
| 组件 | 费用增长趋势 | toggle | ON |
| 数据 | 曲线采样频率 | select | 30s |
| 数据 | 默认时间维度 | select | 分钟 |
| 数据 | 代理端口 | input | 7890 |
| 数据 | 历史数据保留 | select | 7 天 |
| 关于 | API Key | masked input | - |

- 设置面板以模态浮层形式从设置按钮弹出
- 修改即时生效（debounce 300ms），无需手动保存
- "恢复默认"按钮清空所有自定义设置

### 4.6 登录窗口（`login-window`）

- 应用首次启动时弹出独立窗口
- 输入：DeepSeek API Key（`sk-...`）
- 提供「跳过」按钮——跳过登录进入空状态，可在设置中补填
- 输入后即时调用 `GET /user/balance` 验证 key 有效性
- 成功后关闭登录窗口，显示悬浮窗
- API Key 通过 `electron-store` 加密存储（`encryptionKey` 选项）

---

## 五、数据流

### 5.1 启动流程

```
应用启动
  │
  ├─ 读取 electron-store 配置
  │    ├─ 有 API Key? ──是──→ 验证余额 API
  │    │                        ├─ 有效 → 显示悬浮窗，启动代理
  │    │                        └─ 无效 → 显示登录窗口
  │    └─ 无 API Key? ──→ 显示登录窗口
  │
  ├─ 检查开机自启配置 → 设置 LoginItem
  ├─ 创建系统托盘图标
  └─ 读取历史数据 JSON（用于折线图天维度）
```

### 5.2 运行时数据流

```
业务代码                    本应用（Electron Main）
────────                    ──────────────────────
POST http://localhost:7890/chat/completions
      │                          │
      ├──────────────────────────→ HTTP Proxy 收到请求
      │                          │  ├─ 提取 model 名称
      │                          │  ├─ 转发到 https://api.deepseek.com/chat/completions
      │                          │  │   (带 Authorization: Bearer <key>)
      │                          │  ├─ 流式读取响应 → 解析 usage
      │                          │  └─ pipe 原始响应 → 业务代码
      ←──────────────────────────┤
      │                          │
      │                          Aggregator.update(model, usage)
      │                          │  ├─ 按模型累加 token
      │                          │  ├─ 按模型累加费用
      │                          │  ├─ 更新 30s 环形缓冲
      │                          │  └─ 检查是否需要下采样持久化
      │                          │
      │                          ── IPC ──→ Renderer
      │                                      ├─ 更新卡片数字
      │                                      ├─ 更新柱状图
      │                                      └─ 更新折线图（如有新采样点）
      │
      │  ─── 每 30s 定时器 ───→ ringBuffer 推入当前 bucket → 通知 Renderer 重绘折线图
      │  ─── 每 5min 定时器 ──→ 拉取余额 API → 通知 Renderer
      │  ─── 每 5min 定时器 ──→ 持久化当日数据到 JSON
```

### 5.3 天维度切换

```
每天 00:00 执行日切：
  1. 当日聚合数据 → 写入历史 JSON 文件
  2. 当日模型消耗清零
  3. 环形缓冲区保留继续（跨天也保留近 24h 数据）
  4. 历史 JSON 按配置保留 N 天
```

---

## 六、视觉规范（DeepSeek 风格）

### 6.1 颜色系统

| Token | 值 | 用途 |
|-------|-----|------|
| `--primary` | `#4D6BFE` | 主色调，按钮、高亮、图表主色 |
| `--primary-light` | `#7B92FF` | hover 状态 |
| `--primary-dark` | `#3A50CC` | active 状态 |
| `--bg-window` | `rgba(255,255,255,0.92)` | 悬浮窗背景 |
| `--bg-window-dark` | `rgba(30,32,38,0.92)` | 暗色模式悬浮窗背景 |
| `--bg-card` | `#F8F9FC` | 卡片背景 |
| `--bg-card-dark` | `#252730` | 暗色模式卡片背景 |
| `--text-primary` | `#1A1A2E` | 主文字 |
| `--text-secondary` | `#6B7280` | 次要文字 |
| `--text-inverse` | `#FFFFFF` | 反色文字 |
| `--border` | `#E5E7EB` | 边框 |
| `--success` | `#22C55E` | 正常运行状态 |
| `--warning` | `#F59E0B` | 余额不足预警 |
| `--error` | `#EF4444` | 代理异常 |

### 6.2 圆角与阴影

```css
--radius-window: 16px;
--radius-card:   12px;
--radius-btn:    8px;
--radius-input:  8px;
--shadow-window: 0 4px 24px rgba(0,0,0,0.08);
--shadow-card:   0 2px 8px rgba(0,0,0,0.04);
```

### 6.3 字体

```css
font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
font-size: 13px; /* 基础 */
```

### 6.4 动效

- 所有 hover/active 过渡：`transition: all 200ms ease-out`
- 卡片 hover：`transform: translateY(-2px)`
- 设置面板出现：`opacity 0→1 + scale 0.95→1`，`200ms ease-out`
- 数字变化：不带动画（直接替换，减少重绘）

---

## 七、系统托盘

- 托盘图标使用 DeepSeek 鲸鱼标识的简化版（16×16 / 32×32 PNG）
- 右键菜单：
  - 显示/隐藏悬浮窗
  - 启用/暂停代理
  - 设置
  - 退出
- 双击托盘图标：显示/隐藏悬浮窗

---

## 八、性能策略

| 指标 | 预算 | 实现 |
|------|------|------|
| 代理延迟 | < 5ms | `stream.pipe()`，不做 body 缓冲解析 |
| 主进程内存 | < 30MB | 环形缓冲 2880 点，整型存储 |
| 渲染进程内存 | < 20MB | ECharts 实例复用，不创建多余 DOM |
| CPU 空闲 | < 0.5% | 30s 定时器，增量更新，无动画 |
| 持久化 I/O | 每 5min 1 次 | 防抖写入，避免频繁磁盘操作 |
| IPC 消息 | 请求触发 + 30s 定时 | 单次消息 < 1KB JSON |

---

## 九、文件结构

```
deepseek-monitor/
├── package.json
├── electron-builder.yml
├── src/
│   ├── main/
│   │   ├── index.js              # Electron 入口，窗口/托盘/生命周期
│   │   ├── proxy.js              # HTTP 代理服务器
│   │   ├── aggregator.js         # 数据聚合、环形缓冲、日切
│   │   ├── balance.js            # 余额查询
│   │   ├── store.js              # electron-store 配置管理
│   │   └── pricing.js            # 模型定价表
│   ├── renderer/
│   │   ├── index.html            # 悬浮窗主页面
│   │   ├── login.html            # 登录窗口页面
│   │   ├── css/
│   │   │   ├── main.css          # 主样式（DeepSeek 设计系统）
│   │   │   ├── settings.css      # 设置面板样式
│   │   │   └── components.css    # 各组件样式
│   │   ├── js/
│   │   │   ├── app.js            # 渲染进程入口，IPC 监听
│   │   │   ├── settings.js       # 设置面板逻辑
│   │   │   ├── components/
│   │   │   │   ├── fee-cards.js      # 费用概览卡片
│   │   │   │   ├── model-bar.js      # 模型消耗柱状图
│   │   │   │   ├── token-line.js     # Token 增长趋势折线图
│   │   │   │   └── cost-line.js      # 费用增长趋势折线图
│   │   │   └── charts.js         # ECharts 初始化和主题配置
│   │   └── assets/
│   │       ├── icon.png          # 应用图标
│   │       └── tray-icon.png     # 托盘图标
│   └── preload/
│       └── preload.js            # contextBridge 暴露 IPC API
├── assets/
│   └── icon.ico                  # Windows 图标
└── build/                        # electron-builder 输出
```

---

## 十、IPC 接口

### Main → Renderer

| 频道 | 载荷 | 触发 |
|------|------|------|
| `data:update` | `{ models, totalCost, cacheRate }` | 每次代理请求后 |
| `balance:update` | `{ total, granted, toppedUp }` | 每 5min |
| `curve:token` | `{ points: [{time, total, delta}] }` | 每 30s |
| `curve:cost` | `{ points: [{time, total, delta}] }` | 每 30s |
| `proxy:status` | `{ running, port, activeSince }` | 代理启动/停止 |

### Renderer → Main

| 频道 | 载荷 | 用途 |
|------|------|------|
| `settings:update` | `{ key, value }` | 更新单项设置 |
| `settings:reset` | - | 恢复默认 |
| `proxy:restart` | - | 重启代理（端口变更后） |
| `login:submit` | `{ apiKey }` | 提交 API Key |
| `window:minimize` | - | 最小化到托盘 |

---

## 十一、待定（未来迭代）

- 多 API Key 支持
- 暗色/亮色手动切换（当前仅跟随系统）
- 自定义模型定价
- 数据导出（CSV/JSON）
