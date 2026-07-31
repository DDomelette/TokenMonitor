# 设置窗口"平台登录"区块 + 设置/主界面风格统一 设计

日期:2026-07-31
状态:待评审

## 背景

- 会话(sessionToken)过期后,目前唯一的主动重新登录入口是托盘菜单,过于隐蔽;自动弹窗链路(过期检测 → `createSessionWindow()`)存在单点失败风险,需要手动兜底。
- 设置窗口(`settings-window.html`)使用一套独立的内联样式(自定义 `:root` 令牌、10px 圆角、不同的阴影/按钮/滚动条),与主窗口(`css/main.css`,18px 圆角、`--bg-window` 半透明底、统一 SVG 图标按钮、隐藏式滚动条)视觉割裂。

## 目标

1. 设置窗口顶部新增"平台登录"区块:展示会话状态 + 主动登录/重新登录按钮。
2. 设置窗口视觉与主窗口统一:共享同一份设计令牌,消除重复定义。

## 功能一:平台登录区块

### 主进程(`src/main/index.js`)

- `ipcMain.on('session:relogin')` → 调用现有 `createSessionWindow()`。
- `ipcMain.handle('get:session-state')` → 返回 `{ loggedIn: !!sessionToken, error: proxyStatus.error || null }`。
- 新增 `broadcastSessionState()`,向主窗口与设置窗口发送 `session:changed`(payload 同上),调用时机:
  - `createSessionWindow` 内捕获到 token 时;
  - `fetchAndStoreUsage` 判定会话过期时;
  - `sessionWindow` 关闭且未获得 token 时。

### preload(`src/preload/preload.js`)

- send 白名单加 `session:relogin`;invoke 白名单加 `get:session-state`;on 白名单加 `session:changed`。

### 设置界面(`src/renderer/js/settings-window.js`)

- 不走 `settings-definitions.js` 键值模型(登录是动作+状态,不是设置项)。在 `buildPanel` 输出前** prepend **一个"平台登录"区块:
  - 状态行:状态点(复用 `.status-dot` online/offline)+ 文案(`已登录平台` / `未登录或会话已过期`,有 error 时附错误文案);
  - 按钮行:已登录显示"重新登录平台",未登录显示"登录平台获取用量",点击 `window.api.send('session:relogin')`。
- 状态来源:打开设置时 `get:session-state` 拉取一次;之后监听 `session:changed` 实时更新。

## 功能二:设置/主界面风格统一

原则:**令牌单一来源** —— `css/main.css` 的 `:root` 变量与 `body.dark` 覆盖是两窗口唯一的设计令牌。

### `settings-window.html`

- `<head>` 引入 `css/main.css`;删除内联 `<style>` 中的 `:root` / `body.dark` / `body:not(.dark)` 令牌重复定义。
- 结构对齐主窗口:`<body>` 内用 `<div id="app">` 包裹 header/body/footer,直接获得 `var(--bg-window)` 背景、18px 圆角、`var(--shadow-window)` + 边框环;dark 模式自动继承 `body.dark #app`。
- 顶部 header 改用主窗口 `.titlebar` 结构:左侧 `.titlebar-text`"设置",右侧关闭按钮改为 `.titlebar-btn` + 与主窗口一致的 × SVG;保留 `-webkit-app-region: drag`。
- `.settings-body` 滚动条样式对齐 `.content`(10px 宽、透明滑道、hover/滚动时显现)。
- 内联 `<style>` 中保留的设置专属样式(section、setting-row、toggle、slider、select、input、footer、`.btn`)全部改用 main.css 变量;颜色/圆角/过渡与主窗口一致。
- 登录区块样式:复用 `.status-dot`、`.btn` 与 section 样式,不新增令牌。

### 顺手清理

- `css/main.css` / `layout.css` / `components.css` 中上轮改动遗留的 `font-size: calc(13px)` 等无意义 `calc()` 包裹,还原为直接像素值。

## 错误处理

- `get:session-state` 在主窗口未创建时仍可用(settingsWindow 依附 mainWindow,理论不会);`session:relogin` 重复点击由 `createSessionWindow()` 内部的"先关闭旧 sessionWindow"逻辑兜底。
- 设置窗口未打开时 `broadcastSessionState()` 直接跳过(现有 broadcast 判空模式)。

## 测试(沿用 test/ 静态测试风格)

- preload 三个新通道在白名单;
- `index.js` 存在 `session:relogin` handler 且调用 `createSessionWindow()`;存在 `get:session-state` handler;
- `index.js` 三个广播时机调用 `broadcastSessionState()`;
- `settings-window.js` 渲染登录区块(状态点 + relogin 按钮绑定 `session:relogin`);
- `settings-window.html` 引入 `css/main.css` 且不再定义重复的 `:root` 颜色令牌;
- 现有 56 个测试保持通过。

## 改动文件清单

- `src/main/index.js`
- `src/preload/preload.js`
- `src/renderer/settings-window.html`
- `src/renderer/js/settings-window.js`
- `src/renderer/css/main.css`、`layout.css`、`components.css`(仅 calc 清理)
- `test/` 新增静态测试
