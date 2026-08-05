**DeepSeek Monitor Figma 级 UI 升级计划书**

**目标**
把当前应用从“功能可用”提升到“设计稿级精致”：窗口边界、间距、字体、颜色、图表、动画、拖拽缩放、设置面板都做到稳定、统一、可预期，视觉误差控制在 1px 级别。

**一、现状诊断**
当前应用基础不错，已有悬浮窗、透明背景、图表、设置面板、Ghost Preview、窗口物理系统。但要达到 Figma 级，主要差距在：

- 窗口缩放和 ghost 预览框还存在坐标/视觉对齐问题
- 视觉系统还不够统一，颜色、圆角、阴影、间距需要规范化
- 部分组件像“功能拼装”，还没有形成完整设计语言
- 设置页、登录页、主窗口之间的视觉层级不完全一致
- 图表区域、卡片区域、状态栏的比例还可以更精细
- hover、drag、resize、loading、empty、error 等状态需要补齐
- 缺少一套视觉 QA 标准和截图验收流程

**二、设计标准**
最终以这些标准作为验收线：

- 所有边距、间距使用统一 spacing scale：`4 / 6 / 8 / 10 / 12 / 16 / 20`
- 所有圆角统一分级：窗口 `16-18px`，卡片 `8-12px`，按钮 `6-8px`
- 所有字体层级固定：标题、数字、标签、辅助信息各有明确字号和字重
- 所有边框、ghost、resize handle 与真实窗口误差不超过 `1px`
- 所有按钮、开关、滑块、选择框都有 hover / active / disabled 状态
- 明暗主题视觉一致，不只是换背景色
- 图表在不同窗口尺寸下不挤压、不重叠、不跳动
- 拖动、缩放、刷新、打开设置都有平滑但克制的动画

**三、实施阶段**

**Phase 1：视觉系统统一**
整理 [src/renderer/css/main.css (line 1)](/D:/Deepseek_Monitor/src/renderer/css/main.css:1) 和 [components.css (line 1)](/D:/Deepseek_Monitor/src/renderer/css/components.css:1)。

交付物：

- 统一 CSS 变量：颜色、圆角、阴影、字体、间距
- 建立 light / dark 两套 token
- 去掉临时色值和重复样式
- 固定窗口、卡片、按钮、状态栏的视觉规则

**Phase 2：主窗口精修**
重点处理 [src/renderer/index.html (line 1)](/D:/Deepseek_Monitor/src/renderer/index.html:1) 和 [src/renderer/js/app.js (line 1)](/D:/Deepseek_Monitor/src/renderer/js/app.js:1)。

任务：

- 主窗口外边缘、内容 padding、状态栏高度逐像素校准
- Ghost Preview 与真实窗口边界完全对齐
- resize handle 热区稳定，但视觉上不可打扰
- 标题栏按钮统一尺寸、图标、hover 背景
- 主窗口在 `380px` 最小宽度下不挤压、不溢出

**Phase 3：组件重设计**
涉及费用卡、每日 Token 图、Token 趋势、费用趋势。

任务：

- 费用卡数字层级重排，余额、今日消耗、缓存命中率更容易扫读
- 图表 grid、tooltip、坐标轴统一
- 空数据状态补齐，而不是只显示 `--`
- loading / refresh 状态有轻量反馈
- 组件隐藏、排序后布局仍然稳定

**Phase 4：设置页 Figma 化**
重点是 [settings-window.html (line 1)](/D:/Deepseek_Monitor/src/renderer/settings-window.html:1) 和 [settings-window.js (line 1)](/D:/Deepseek_Monitor/src/renderer/js/settings-window.js:1)。

任务：

- 设置窗口拖动、缩放修复完整
- 设置项分组更清楚，但不做厚重卡片堆叠
- 开关、滑块、选择框统一控件风格
- API Key 输入区增加安全感和状态反馈
- 重置按钮增加确认或更明确的危险样式

**Phase 5：登录与平台授权体验**
涉及 [login.html (line 1)](/D:/Deepseek_Monitor/src/renderer/login.html:1)。

任务：

- 登录页视觉和主窗口保持同一品牌语言
- 输入错误、验证中、验证成功状态补齐
- “跳过”按钮语义重新评估，避免用户困惑
- 平台登录窗口打开前给出清晰状态反馈

**Phase 6：交互与动效**
重点是窗口物理系统：

- 拖动 ghost 使用目标位置，不出现滞后错位
- 缩放时 ghost、真实窗口、保存状态三者一致
- 动效时间控制在 `120-220ms`
- hover 反馈轻，不抢图表信息
- 移除生产环境 debug overlay，或改成开发开关

**Phase 7：验收与 QA**
建立一套固定检查清单：

- `380x520`、`420x680`、`600x760` 三档窗口截图
- light / dark 两套主题截图
- 有数据 / 无数据 / API 失败 / session 过期四种状态
- 拖动、四边缩放、四角缩放逐项验证
- 检查文字是否溢出、图表是否遮挡、按钮是否错位

**建议优先级**
第一优先级：

1. 主窗口缩放与 ghost 对齐
2. 主窗口 spacing / 边框 / 状态栏精修
3. 费用卡和图表视觉统一

第二优先级：

1. 设置页控件统一
2. 登录页状态补齐
3. 明暗主题精修

第三优先级：

1. 动效细节
2. 空状态和错误状态
3. 截图 QA 流程自动化

**最终交付**
完成后项目里应有：

- 一套稳定 UI token
- 一套 Figma 级主窗口
- 一套统一设置页和登录页
- 一套窗口拖拽/缩放视觉规范
- 一份 QA 截图验收清单
- 一份后续迭代规范，避免以后改功能时把视觉细节打散