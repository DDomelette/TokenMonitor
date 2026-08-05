# DeepSeek Monitor 产品级 UI 与 Window Physics Engine 升级计划书

## 项目愿景

将 DeepSeek Monitor 从：

```text
Electron App
```

升级为：

```text
UI Physics Engine
        +
Design System
        +
Product-grade Desktop Client
```

最终目标不是获得一个“更好看的窗口”，而是建立一套长期稳定、可持续演化的桌面客户端架构。

系统需要同时满足：

- Figma 级视觉精度
- Window Physics Engine 稳定性
- Design System 一致性
- 产品级 QA 验收能力
- 后续功能迭代不破坏视觉与交互品质

------

# 一、总体目标

最终验收标准：

## Window System

Ghost、WindowState、BrowserWindow 三者始终一致：

```text
Ghost == WindowState == BrowserWindow
```

允许误差：

```text
≤ 1px
```

支持：

- 拖动
- 四边缩放
- 四角缩放
- 最小尺寸约束
- 最大尺寸约束
- 边缘吸附
- 多显示器
- DPI 缩放

------

## Visual System

建立统一 Design Token：

### Spacing

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

### Radius

```text
Window     16~18
Card       8~12
Button     6~8
```

### Typography

固定层级：

```text
Display
Title
Body
Label
Caption
```

禁止组件自行定义字号。

------

## Interaction

所有组件必须拥有完整状态矩阵：

| State    | Required    |
| -------- | ----------- |
| Default  | ✓           |
| Hover    | ✓           |
| Active   | ✓           |
| Disabled | ✓           |
| Loading  | ✓           |
| Error    | ✓（如适用） |

------

## Performance

目标预算：

```text
60 FPS
```

窗口拖动与缩放期间：

```text
Frame Drop < 5%
```

要求：

- 无明显 Layout Thrash
- 无连续 Reflow
- 图表刷新不卡顿
- Ghost 不抖动
- Commit 无跳变

------

# 二、现有架构基础

已完成：

## Window Physics Runtime

### WindowState

唯一状态源：

```text
Current
Target
Velocity
Flags
```

------

### Physics Runtime

负责：

```text
Target
   ↓
Physics
   ↓
Current
```

------

### Commit Manager

负责：

```text
Current
   ↓
BrowserWindow
```

避免连续 setBounds。

------

### Constraint Engine

已完成：

```text
MinWidth
MinHeight
MaxWidth
MaxHeight
```

已升级：

```text
Rule Framework
```

支持未来规则插拔。

------

# 三、Architecture Freeze

进入 UI 精修阶段前冻结核心运行时。

冻结模块：

```text
WindowState
Physics Runtime
Commit Manager
Constraint Engine
Rule Framework
```

原则：

```text
除 Bug 外禁止重构
```

避免：

```text
UI问题
和
Physics问题
互相污染
```

------

# 四、实施路线

------

## Phase 1

## Design System Foundation

建立统一视觉基础设施。

### 交付

Design Token：

```text
Color
Spacing
Radius
Shadow
Typography
Motion
```

Light Theme：

```text
theme-light
```

Dark Theme：

```text
theme-dark
```

建立 Token Governance：

### 规则

禁止：

```css
color:#3b82f6;
border-radius:12px;
box-shadow:...
```

允许：

```css
color:var(--color-primary);
border-radius:var(--radius-card);
```

------

## Phase 2

## Window Physics QA

验证运行时稳定性。

检查：

### Drag

```text
Ghost
WindowState
BrowserWindow
```

一致性。

------

### Resize

验证：

```text
Top
Bottom
Left
Right
TL
TR
BL
BR
```

全部方向。

------

### DPI

测试：

```text
100%
125%
150%
200%
```

确保：

```text
误差 ≤ 1px
```

------

## Phase 3

## Main Window Refinement

重点：

```text
index.html
app.js
```

任务：

### Ghost Alignment

实现：

```text
Ghost == Real Window
```

视觉对齐。

------

### Layout Calibration

逐像素校准：

```text
Padding
Status Bar
Header
Chart Area
```

------

### Responsive Rules

窗口不足时：

Level 1

```text
压缩间距
```

Level 2

```text
压缩图表
```

Level 3

```text
隐藏辅助信息
```

Level 4

```text
停止压缩
```

避免布局崩溃。

------

## Phase 4

## Component System Redesign

涉及：

```text
Cost Card
Token Chart
Trend Chart
Status Card
```

统一：

### Grid

### Tooltip

### Axis

### Empty State

### Loading State

### Error State

建立组件语言。

------

## Phase 5

## Settings Experience

涉及：

```text
settings-window
```

目标：

设置页与主窗口视觉统一。

统一：

```text
Input
Select
Switch
Slider
Button
```

风格。

------

## Phase 6

## Login Experience

涉及：

```text
login.html
```

补齐：

```text
Validating
Success
Error
Offline
```

状态。

保证与主窗口品牌一致。

------

## Phase 7

## Snap & Dock System

基于 Constraint Rule Framework。

新增：

### Edge Snap

```text
距离边缘 < N px
```

自动吸附。

------

### Center Snap

```text
窗口中心吸附
```

------

### Guide Line

显示辅助线。

------

### Dock Rule

支持未来：

```text
Panel Dock
Widget Dock
```

能力。

------

## Phase 8

## Motion System

建立统一动画体系。

时间规范：

```text
120~220ms
```

适用于：

```text
Hover
Focus
Panel
Open
Close
Ghost
```

动画。

原则：

```text
平滑
克制
可预测
```

------

## Phase 9

## Visual Regression QA

建立固定截图库。

场景：

### Window Sizes

```text
380x520
420x680
600x760
```

------

### Themes

```text
Light
Dark
```

------

### States

```text
Data
Empty
Error
Expired Session
```

------

### Physics

```text
Drag
Resize
Snap
Dock
```

截图对比。

------

# 五、最终交付

项目最终应具备：

## Runtime

```text
WindowState
Physics Runtime
Constraint Engine
Rule Framework
Snap Engine
Commit Manager
```

------

## Design System

```text
Color Tokens
Spacing Tokens
Typography Tokens
Motion Tokens
Theme Tokens
```

------

## Product UI

```text
Main Window
Settings
Login
Charts
Cards
```

统一语言。

------

## QA System

```text
Physics QA
Visual QA
Regression QA
```

完整闭环。

------

# 最终目标

完成后，DeepSeek Monitor 不再是：

```text
一个 Electron 工具窗口
```

而是：

```text
一个拥有 Window Physics Engine、
Design System、
Visual QA、
长期演进能力的桌面产品平台。
```