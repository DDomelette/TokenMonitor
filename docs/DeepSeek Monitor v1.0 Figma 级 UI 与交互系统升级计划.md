# DeepSeek Monitor v1.0 Figma 级 UI 与交互系统升级计划

## 项目目标

DeepSeek Monitor 当前已经完成窗口物理系统基础架构建设：

```text
Input
 ↓
Intent
 ↓
WindowState
 ↓
Constraint Engine
 ↓
Physics Runtime
 ↓
Ghost Preview
 ↓
Commit Manager
 ↓
BrowserWindow
```

BrowserWindow 已经从状态源降级为输出设备。

下一阶段目标不再是解决 Electron Bug，而是基于现有 Runtime 构建：

- Figma 级视觉质量
- 统一设计语言
- 可持续演化的 Design System
- 稳定的窗口交互体验
- 可验证的 QA 体系

最终达到：

```text
产品级客户端
=
UI System
+
Window Physics System
+
Design Token System
+
QA Validation System
```

------

# 第一部分：架构冻结

## 目标

在进入视觉升级前，冻结已经验证通过的 Runtime 架构。

冻结范围：

- WindowState
- Physics Runtime
- Constraint Engine
- Rule Framework
- Commit Manager

原则：

- UI 升级期间不进行 Runtime 重构
- 非缺陷问题不修改物理系统
- UI 问题与 Physics 问题独立排查

验收标准：

```text
Ghost
=
WindowState
=
BrowserWindow
```

持续成立。

------

# 第二部分：设计系统建设

## Phase 1：Design Token System

建立统一设计 Token。

禁止：

```css
color:#3b82f6;
border-radius:12px;
box-shadow:...
```

直接出现在业务代码。

统一使用：

```css
var(--color-primary)
var(--radius-card)
var(--shadow-card)
```

### Token 分类

颜色：

```text
Primary
Success
Warning
Danger
Surface
Background
Border
Text
```

间距：

```text
4
6
8
10
12
16
20
24
32
```

圆角：

```text
XS
SM
MD
LG
XL
```

阴影：

```text
Subtle
Card
Floating
Modal
```

字体：

```text
Display
Heading
Body
Label
Caption
Numeric
```

------

## Phase 1.5：Token Governance

建立 Token 管理规则。

要求：

- 禁止新增临时 Token
- 禁止重复语义 Token
- Token 必须有用途说明
- 废弃 Token 必须登记

目标：

避免后期出现：

```text
primary
primary2
primary-v2
button-blue
theme-blue
```

等失控情况。

------

# 第三部分：主窗口精修

## Phase 2：Main Window Refinement

目标：

实现 Figma 与运行时视觉一致。

### 边界系统

验证：

```text
Ghost Border
=
Window Border
```

误差：

```text
≤ 1px
```

### 内容布局

统一：

- 顶部区域
- 图表区域
- 卡片区域
- 状态栏区域

建立固定布局比例。

### Resize Handle

要求：

- 热区稳定
- 视觉隐藏
- 不影响内容区域

### 标题栏

统一：

- 按钮尺寸
- 图标尺寸
- Hover 行为
- Active 行为

### 最小尺寸

窗口宽度：

```text
380px
```

时：

- 不溢出
- 不重叠
- 不压缩数字

------

# 第四部分：组件系统重构

## Phase 3：Component System

目标：

从功能组件升级为产品组件。

### 费用卡

重构信息层级：

```text
余额
↓
今日消耗
↓
缓存命中率
↓
辅助信息
```

保证扫描效率。

### 图表系统

统一：

- Grid
- Tooltip
- Axis
- Legend

行为一致。

### 状态系统

所有组件必须支持：

```text
Default
Hover
Loading
Empty
Error
Refresh
```

禁止：

```text
--
```

作为空状态。

### 响应式布局规则

建立优先级：

Level 1：

```text
压缩间距
```

Level 2：

```text
压缩图表
```

Level 3：

```text
隐藏辅助信息
```

Level 4：

```text
停止压缩
```

禁止内容重叠。

------

# 第五部分：设置页重构

## Phase 4：Settings Experience

目标：

与主窗口共享同一设计语言。

### 控件统一

统一：

- Toggle
- Slider
- Select
- Input

视觉风格。

### 设置分组

要求：

- 分组清晰
- 避免重卡片堆叠
- 保持轻量化

### API Key 区域

增加：

- 输入状态
- 保存状态
- 验证反馈

### 危险操作

例如：

```text
重置设置
```

增加：

- 确认流程
- 危险视觉提示

------

# 第六部分：登录与授权体验

## Phase 5：Authentication Experience

目标：

登录页与主窗口品牌统一。

补齐状态：

```text
Default
Typing
Validating
Success
Error
```

优化：

```text
跳过登录
```

语义表达。

增加：

```text
正在打开平台授权窗口
```

状态反馈。

------

# 第七部分：窗口交互与动画

## Phase 6：Interaction System

基于 Window Physics Runtime。

### Drag

要求：

```text
Ghost Target
=
Physics Target
```

无视觉滞后。

### Resize

保证：

```text
Ghost
Window
Persisted State
```

完全一致。

### 动画规范

持续时间：

```text
120~220ms
```

原则：

```text
可感知
不抢焦点
```

### Hover

目标：

辅助信息表达。

不得干扰：

- 图表阅读
- 数据观察

### Overlay

生产环境：

```text
关闭
```

开发环境：

```text
可切换
```

------

# 第八部分：性能预算

## Phase 6.5：Performance Budget

建立硬性指标。

目标：

Renderer：

```text
FPS ≥ 60
```

Resize：

```text
Frame Drop < 5%
```

要求：

- 无明显卡顿
- 无连续 Layout Thrash
- 图表刷新稳定

------

# 第九部分：窗口物理系统专项 QA

## Phase 7：Window Physics QA

验证：

```text
Ghost
=
WindowState
=
BrowserWindow
```

场景：

- 拖动
- 左缩放
- 右缩放
- 上缩放
- 下缩放
- 四角缩放

验证：

- 最小尺寸约束
- 最大尺寸约束
- Rule Engine

专项测试：

```text
100%
125%
150%
200%
```

DPI。

确保：

```text
误差 ≤ 1px
```

------

# 第十部分：视觉 QA 与回归验证

## Phase 8：Visual QA

固定截图集：

### Window Sizes

```text
380x520
420x680
600x760
```

### Themes

```text
Light
Dark
```

### States

```text
Data Available
No Data
API Failure
Session Expired
```

### Pages

```text
Main Window
Settings
Login
```

检查：

- 文字溢出
- 图表遮挡
- 控件错位
- 状态缺失

------

## Visual Regression

建立版本截图基线。

后续修改：

```text
功能
样式
布局
```

均进行对比验证。

避免视觉退化。

------

# 优先级规划

## P0

- Runtime Freeze
- Ghost 与窗口边界对齐
- Window Physics QA

## P1

- Design Token
- Theme System
- Typography
- Spacing System

## P2

- 主窗口重构
- 图表重构
- 费用卡重构

## P3

- 设置页重构
- 登录页重构

## P4

- 动画系统
- Visual Regression
- QA 自动化

------

# 最终交付物

完成后项目应具备：

### Runtime

- WindowState Runtime
- Physics Runtime
- Constraint Engine
- Rule Framework

### UI System

- Design Token System
- Unified Component System
- Theme System

### Product Experience

- Figma 级主窗口
- Figma 级设置页
- Figma 级登录体验

### Quality System

- Window Physics QA
- Visual QA Checklist
- Visual Regression Baseline

### Governance

- Design Token Governance
- UI Evolution Guidelines

确保未来新增功能时：

```text
功能扩展
≠
视觉退化

功能扩展
≠
架构污染
```