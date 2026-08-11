# 诊断与支持中心设计

日期：2026-08-09

状态：方案 1 与书面规格均已确认；2026-08-11 安全审查修订已获用户确认

目标分支：`main`

开发分支：`codex/issue-169-diagnostics-center`

## 背景

Token Monitor 已分别具备 Store recovery、Provider health、HTTP timeout、代理解析、Codex/Kimi 本地日志和 Windows Acrylic 等基础能力，但最终用户没有统一的只读诊断入口。出现“应用能启动、单项功能异常”时，目前仍需要人工收集版本、系统、凭证状态、网络边界和日志状态。

本设计实现 Issue #169 的完整 MVP：设置页增加“诊断与支持”入口，打开独立 Diagnostics 窗口，逐项运行无破坏性的探针，展示实时状态、失败原因和离线排障手册，并生成经过脱敏的可复制报告。

## 范围

### 本次实现

- 独立 Diagnostics BrowserWindow，以及设置页入口。
- `pending`、`running`、`pass`、`fail`、`skipped` 五种状态。
- 应用运行环境、Store、本地存储、Windows/Acrylic、GPU、网络/代理、DeepSeek、Codex、Kimi 和 scheduler 运行状态诊断。
- 每个失败项映射到稳定的本地 `guideId`。
- 重新诊断、复制脱敏报告。
- 离线 Markdown 手册随安装包分发。
- 单项异常、超时、重复运行和窗口关闭的隔离处理。

### 明确不实现

- 自动修改系统设置、注册表、凭证、代理、Store 或 cursor。
- 自动刷新 Codex/Kimi token。
- Acrylic A/B 人工视觉比较区。
- `--diagnostics` 启动模式和 startup fatal error 诊断入口。
- 自动提交 Issue 或上传诊断报告。

## 方案选择

采用模块化只读探针注册表与实时 IPC 事件。每个探针是独立、可注入依赖、可单元测试的函数；runner 统一负责状态转换、超时、异常归一化和进度发送。

最终安全审查推翻了原设计中的三个假设：共享 preload 不等于最小权限、`Promise.race` 不等于取消底层资源、应用生命周期缓存不等于重新诊断。修订后采用以下方案：

- **采用：独立 Diagnostics preload + 专用主题投影 + 可取消 run scope。** Diagnostics renderer 只获得诊断、关闭、主题和 focus 所需的最小 API；每个 run 捕获一次代理和 Windows 能力，底层网络资源受共享并发器与 `AbortSignal` 约束。
- 未采用“继续共享 preload、再给所有写 IPC 增加 sender 授权”：需要改造大量现有 handler，容易遗漏新通道，仍不是 capability-level 隔离。
- 未采用“完全移除 Diagnostics 主题同步”：权限面最小，但会造成次级窗口主题和 Acrylic 状态不一致；专用只读主题投影能保留体验而不暴露 Store payload。

未采用以下方案：

- 单体诊断服务：文件较少，但 Windows FFI、网络、Provider 和 Store 边界会互相耦合，难以证明无副作用。
- 一次性快照：不能真实反映逐项运行进度，也无法可靠处理永久 spinner、旧运行事件和单项超时。

## 总体架构

```text
Settings renderer
  -> open:diagnostics
Main window lifecycle
  -> Diagnostics BrowserWindow
Diagnostics renderer
  -> diagnostics:run
IPC orchestration
  -> diagnostics runner
     -> runtime/storage/windows/network/provider probes
     -> sanitized progress events
Diagnostics renderer
  -> diagnostics:open-guide / diagnostics:copy-report
Main process
  -> local Markdown / clipboard
```

建议的代码边界：

```text
src/main/core/diagnostics/
├── index.js              # 组装检查清单与公开入口
├── runner.js             # runId、状态机、并发、超时、异常隔离
├── results.js            # 结果构造、错误码与安全摘要
├── report.js             # 报告格式化与二次脱敏
├── guides.js             # guideId 白名单与开发/打包路径解析
├── readonly-log.js       # 小样本日志枚举与读取，绝不使用 cursor
└── checks/
    ├── runtime.js
    ├── storage.js
    ├── windows.js
    ├── network.js
    └── providers.js
src/preload/diagnostics-preload.js # Diagnostics 窗口的最小权限 bridge
```

窗口生命周期仍由 `src/main/index.js` 管理，IPC handler 仍由 `src/main/ipc.js` 注册。renderer 使用独立的 HTML、CSS、控制器和可纯测状态模块，不向现有 `settings-window.js` 塞入诊断业务逻辑。

## 统一结果模型

每个检查定义包含固定元数据：

```js
{
  id: 'windows.acrylic-accent',
  group: 'Windows / 渲染',
  title: 'Accent Acrylic',
  guideId: 'windows-acrylic',
  timeoutMs: 8000,
  run: async (context) => result
}
```

对 renderer 可见的结果只允许以下安全结构：

```js
{
  id: 'windows.acrylic-accent',
  group: 'Windows / 渲染',
  title: 'Accent Acrylic',
  status: 'pass',
  summary: 'Accent API 探测正常；视觉效果仍受系统透明效果影响',
  errorCode: null,
  guideId: 'windows-acrylic',
  metadata: { apiAvailable: true }
}
```

约束：

- `status` 只能是 `pending | running | pass | fail | skipped`。
- `running` 是唯一黄色状态；没有 warning 状态。
- `skipped` 用于未配置、不适用或无法安全确认的检查，不显示红色。
- 每个可能失败的检查必须有非空 `guideId`。
- `summary` 和 `metadata` 在进入 runner 结果前已经脱敏。
- 未知异常只显示稳定错误码和通用文案，不直接透传 `error.message` 或 stack。

## Runner 与状态流

`diagnostics:run` 是 invoke handler。它同步生成 `crypto.randomUUID()` 形式的 `runId`，返回全部检查的 `pending` 快照，并用下一轮事件循环开始执行，确保 renderer 在进度事件到达前已经取得 `runId`。

每项检查的状态流为：

```text
pending -> running -> pass | fail | skipped
```

runner 的规则：

- 开始检查前发送 `diagnostics:progress` 的 `running` 结果。
- 每个 run 拥有 `AbortController`、deadline 和 run scope；每项检查再派生自己的 timeout signal。默认 8 秒，Provider 网络检查最多 12 秒。
- timeout 必须中止可取消的 DNS/TCP/CONNECT/TLS/HTTP 资源；不可取消的外部 Promise 迟到结果被丢弃，但在真实 settle 前仍占用共享 permit。
- timeout 转换成 `fail` 和稳定错误码，不允许 spinner 永久旋转。
- 捕获单项异常并继续其他检查。
- local、Windows、remote、final 使用独立顺序 phase；网络和 Provider 检查通过 Diagnostics 实例级共享 semaphore，所有 run 合计的底层 active remote 资源最多 3。
- 不向 Store 持久化诊断结果。

IPC 为每个 Diagnostics `webContents.id` 保存当前 active `runId`。重新诊断时替换 active id：

- 旧运行的迟到事件不再发送。
- 旧运行立即 abort 当前可取消检查，并停止启动后续检查；不可取消 Promise 仍持有 permit 直到真实 settle。
- 新 run、窗口关闭或 dispose 会 abort 旧 run；发送前同时检查 exact sender、record identity、runId 和 `sender.isDestroyed()`。
- HTTP、代理 TCP、CONNECT、TLS 和 Provider diagnostics transport 接受 signal/deadline；wrapper timeout 后不得让底层连接继续占用未计数资源。

主进程仅在内存中保留当前窗口当前 `runId` 的脱敏结果快照，供 `diagnostics:copy-report` 使用。新运行替换旧快照，窗口关闭立即删除；结果不写入 Store 或文件。复制请求必须来自拥有该 `runId` 的 Diagnostics `webContents`，不能读取其他窗口或历史运行。

## IPC 与窗口生命周期

新增通道：

- `open:diagnostics`：设置 renderer 请求打开窗口。
- `window:close-diagnostics`：关闭 Diagnostics 窗口。
- `diagnostics:run`：创建新运行，返回 `{ runId, checks }`。
- `diagnostics:progress`：发送 `{ runId, check, completed, total }`。
- `diagnostics:open-guide`：按白名单 `guideId` 打开本地 Markdown。
- `diagnostics:copy-report`：按 `runId` 生成并写入系统剪贴板。

设置页的 `open:diagnostics` 保留在现有 preload；Diagnostics BrowserWindow 改用 `src/preload/diagnostics-preload.js`。

专用 preload 仅暴露 `diagnostics:run/progress/copy-report/open-guide/get-theme`、`window:close-diagnostics`、`theme:changed` 和 `window:focus-state` 的窄 API，不暴露通用 `send/invoke/on`，也不包含 settings、history sync、provider refresh、API-key replacement 或 MCP token 通道。

`diagnostics:get-theme` 只返回主题所需的 allowlisted projection，不返回完整 `get:settings`/`settings:loaded` payload。renderer 不获得 Node、`fs`、Store、shell、clipboard、cursor、local-log root、完整文件名或原始运行上下文。

Diagnostics BrowserWindow：

- 默认约 720×640，可调整大小，有合理的最小尺寸。
- 使用独立最小权限 preload、`contextIsolation: true`、`nodeIntegration: false`。
- 复用现有主题、圆角、Accent/fallback 和 focus-state 处理。
- 重复打开时聚焦现有 Diagnostics 窗口，不使用设置窗口现有的 toggle-close 行为。
- Diagnostics 不加入 settings payload 广播；主题变化只触发专用投影重新读取。

## 诊断项目

### 应用运行环境

- App、Electron、Node、Chromium、OS 和 arch 作为信息型 pass 结果。
- Windows build 单独记录；非 Windows 为 `skipped`。
- `renderer/dist/index.html`、preload 和 Diagnostics 页面构建产物存在性。
- `diagnostics:run` 成功进入主进程视为 IPC round-trip 已通过。
- window reference 检查读取 live main/settings/login/session/diagnostics 引用；存在引用时必须验证 `isDestroyed()`，不能把已销毁对象当作正常。
- 主窗口、设置窗口和 Diagnostics 窗口引用可取得且未销毁。
- 最后一项 self-check 确认 runner 已完成所有预期终态。

### 配置与本地存储

- `app.getPath('userData')` 可访问。
- Store 已初始化，并能读取安全字段。
- 若 Store 文件存在，仅读取 bytes 验证文件可访问；由于现有 `electron-store` 启用了 `encryptionKey`，不把磁盘内容当作明文 JSON 解析。配置解密/解析成功由“Store 已初始化且能读取安全字段”证明。
- 在 `userData` 下创建带随机名称的零敏感临时文件；只有 exclusive `openSync(..., 'wx')` 成功后才标记 owned，`finally` 只关闭并删除 owned 文件。`EEXIST` 或 open 失败不得删除碰撞目标。
- 检查 encryption key/config 所需文件的存在性、可读性和格式状态，但不输出 key。
- 用现有 proxy normalize 和 settings schema 规则检查 `providers.proxyUrl`、`data.historyDays` 等关键值。

### Windows / Acrylic / GPU

- 平台、Windows 11/build 信息。
- Windows build 是 native Acrylic probe 的前置 gate；unknown 或低于支持 build 时，不加载 Koffi/DLL、不绑定 Accent API、不创建临时窗口。GPU 可作为独立的 Electron 只读 probe。
- 通过 koffi 只读绑定 `DwmIsCompositionEnabled`。
- 分别报告 koffi runtime、`user32.dll`、`dwmapi.dll`、`gdi32.dll` 和所需 FFI 绑定状态。
- 检查 `getNativeWindowHandle()` 是否返回有效 buffer。
- 创建 `show: false` 的临时 BrowserWindow，应用 Accent 后立即 clear 并在 `finally` destroy；不触碰系统设置。
- 在同一临时窗口测试 Electron `setBackgroundMaterial('acrylic')` fallback 是否可调用。
- 使用 Electron `app.getGPUFeatureStatus()` 和 `app.getGPUInfo('basic')` 输出安全的 feature 状态，不输出设备路径或用户目录。
- 系统透明效果若没有可靠、无副作用的读取路径，明确返回 `skipped`，不误报 pass。
- Accent API 成功时文案仍说明“API probe 正常，但最终视觉效果受系统透明效果和图形环境影响”。
- Windows capability Promise 属于单个 run；点击“重新诊断”必须重新探测，不复用应用生命周期缓存。

### 网络与代理

- 使用现有 `normalizeStoredProxyValue`、`classifyStoredProxyValue` 和系统代理 resolver，不修改设置。
- 每个 run 开始时读取一次当前 direct/custom/system 配置，并在该 run 的 network/provider checks 中共享；下一次 run 必须重新读取。
- 直连、自定义 HTTP 代理、系统代理分别显示模式。
- 自定义代理检查 host/port TCP 建连；系统代理检查 resolve 结果。
- 只读 endpoint probe 区分 DNS、TCP、代理 CONNECT、TLS、HTTP、timeout 和未知网络错误。
- 连接 DeepSeek API、DeepSeek Platform、ChatGPT quota 和 Kimi coding 所需 endpoint。
- HTTP 401/403 对网络检查记为 pass，并在 Provider 凭证检查中判定认证失败。
- endpoint probe 不记录或回传 Authorization header。

### DeepSeek

- API Key 未配置时 `skipped`；已配置时使用现有只读余额接口验证。
- platform session 未配置时 `skipped`；已配置时使用当月只读 usage endpoint 验证。
- 调用底层只读 fetcher，不调用会持久化回填数据的 provider `fetchUsage()`。
- 所有结果只输出“是否配置、是否可用、错误类别”，不输出 token。

### Codex

- `~/.codex/auth.json` 存在、可读、JSON 可解析。
- access token、account id、refresh token 只输出 boolean；JWT 只输出有效、临期、过期或无法解析。
- 绝不调用 `ensureFresh()` 或 `refreshAuth()`。
- `~/.codex/sessions` 存在且可读，并能发现 `rollout-*.jsonl`。
- 从一个匹配文件读取有界小样本，调用纯函数 `parseRolloutLine()`；不调用 `readLocalLog()`、`scanFiles()`，不推进 cursor。
- token 尚有效时直接调用 quota endpoint；过期时 `skipped`，不刷新。

### Kimi

- `~/.kimi-code/credentials/kimi-code.json` 存在、可读、JSON 可解析。
- access、refresh、expiry 字段只输出 boolean/状态。
- 绝不调用 `ensureFresh()` 或 `refreshCred()`。
- `~/.kimi-code/sessions` 存在且可读，并能发现 `wire.jsonl`。
- 读取一个有界小样本并调用纯函数 `parseWireLine()`；不调用 `readLocalLog()`，不触发 migration、不写 cursor。
- token 尚有效时直接调用 quota endpoint；过期时 `skipped`，不刷新。

### 当前运行状态

- 将 scheduler `getSnapshot()` 的 `authStatus`、`lastErrorChannel`、`lastFailedAt`、`lastFetchedAt`、`stale` 加入独立辅助结果。
- `lastError` 经过稳定归类和脱敏，不直接复制任意原始错误。
- scheduler 状态不能代替主动探针，只作为最后一组观察信息。

## Renderer 设计

新增独立 Diagnostics 页面：

- 顶部显示简短说明、总体计数和运行状态。
- 按组展示检查项；每项包含状态图标、标题、summary 和失败手册链接。
- `pending/skipped` 灰色，`running` 黄色圆形 spinner，`pass` 绿色，`fail` 红色。
- “查看解决手册”为蓝色按钮式链接，仅在 `fail` 时出现。
- 底部固定“重新诊断”和“复制诊断结果”按钮。
- 复制按钮在首个运行尚无终态结果时禁用；成功后显示短暂确认，不在页面暴露报告中的敏感原文。
- guide 缺失或系统打开失败时，在对应行显示明确错误，不静默失败。
- 状态区域使用 `aria-live`；spinner 有可读状态文本。
- 页面不调用通用 `get:settings`；初始和 `theme:changed` 时只调用 `diagnostics:get-theme`。

纯状态模块只接受 `{ activeRunId, checksById }`：

- `startRun(snapshot)` 替换当前 run。
- `applyProgress(event)` 只接受与 active runId 相同的事件。
- 检查定义顺序固定，事件更新不改变行顺序。
- renderer 不自行推断 pass/fail，也不保存原始异常。

设置页新增 `type: 'diagnostics'` 的“运行诊断”动作项，按钮只发送 `open:diagnostics`，不把诊断状态塞入 370×520 的设置列表。

## 离线手册

手册源文件位于 `docs/diagnostics/<guideId>.md`。MVP guideId：

- `app-runtime`
- `storage-user-data`
- `storage-config`
- `windows-acrylic`
- `windows-gpu`
- `network-proxy`
- `network-tls`
- `deepseek-api-key`
- `deepseek-session`
- `codex-auth`
- `codex-local-log`
- `kimi-auth`
- `kimi-local-log`

每份手册包含：检查内容、常见原因、安全检查步骤、风险操作提醒、仍未解决时应复制的报告部分。

`electron-builder.yml` 使用 `extraResources` 将 `docs/diagnostics` 复制为安装资源目录中的 `diagnostics-guides`。不把只能存在于 `app.asar` 内的路径直接交给系统 Markdown 程序。

路径解析：

- 开发环境：仓库 `docs/diagnostics`。
- 打包环境：`process.resourcesPath/diagnostics-guides`。
- `guideId` 必须命中常量白名单；禁止任意路径、`..` 和绝对路径输入。
- `shell.openPath()` 返回非空错误字符串时转成结构化失败，renderer 显示错误。

## 隐私与无副作用保证

主进程遵循“先最小化数据，再脱敏”的顺序：

- 探针只返回 boolean、枚举、计数、版本和稳定错误码。
- 不把 API Key、session、access/refresh token、encryption key、Authorization header 或完整配置放进结果对象。
- 不把完整 session 文件名放入结果；只输出匹配文件数量和 parser 是否成功。
- home path 统一替换为 `~`；其他绝对路径默认不进入报告。
- error 通过 allowlist 分类；未知错误不直接透传 message。
- report formatter 再对 JWT、Bearer、常见 secret 字段和 home path 做防御性二次脱敏。
- metadata 采用每项 allowlist；`accountId/account_id`、path/fileName/stack/credential 等未声明字段 fail-closed 丢弃。文本脱敏对大小写、Windows 分隔符和 quoted JSON secret 字段同样生效。
- clipboard 只接收 formatter 的最终字符串。

禁止调用：

- Codex/Kimi `ensureFresh`、refresh、provider `fetchQuota()`。
- Codex/Kimi `readLocalLog()` 或任何带 cursor Store 的扫描。
- DeepSeek 会写 `usageDaily`/`fetchedMonths` 的 provider `fetchUsage()`。
- `sync:history`、settings 写入、Store reset/recovery 修改路径。
- Diagnostics preload 不得使上述通道可达；只读保证既约束探针实现，也约束 renderer capability。

允许的唯一写入是 owned 随机临时文件 probe；它不覆盖或删除碰撞文件，且无论成功、失败或 timeout 都清理自己创建的文件。

## 错误处理

- 未配置且非必需：`skipped`，说明如何启用。
- 不适用平台：`skipped`。
- 无可靠安全探测方式：`skipped`，明确“无法安全确认”。
- 认证失败：Provider 项 `fail`，网络项仍可 `pass`。
- 网络阶段失败：`fail`，保留稳定阶段码并映射相应手册。
- 单项异常或 timeout：该项 `fail`，后续检查继续。
- guide 缺失：诊断结果保持不变，点击后显示 `GUIDE_NOT_FOUND`。
- 窗口关闭：停止新检查和进度发送，abort 当前可取消资源；不可取消 Promise 继续占用共享 permit 直到 settle，但不能发送迟到结果。

## 测试与验证

所有产品代码按 TDD 编写。至少覆盖：

### Runner 与结果

- `pending -> running -> pass/fail/skipped`。
- 某项抛异常不会阻止后续检查。
- timeout 终止 spinner 并生成稳定失败。
- 并发上限不超过 3。
- 统计底层 active sockets/requests 而非 wrapper Promise；单 run timeout 和跨 rerun 峰值都不超过 3，abort 后资源归零。
- 第二次运行后，旧 runId 事件不能更新 UI 或继续启动新检查。
- sender/window 销毁后不发送 IPC 异常。
- 每个 fail 结果都有有效 guideId。

### 无副作用

- Codex auth 和 Kimi credential 在诊断前后 bytes 完全一致。
- Store spy 未收到 cursor、migration、usageDaily 或凭证写入。
- 日志 probe 不调用业务 `readLocalLog()`。
- 临时文件在成功、失败和异常路径都无残留。
- `EEXIST` fixture 的 bytes 保持不变，且 open 失败路径不调用 remove。
- Windows 临时窗口始终 clear/destroy，且不改持久设置。
- unsupported/unknown Windows build 不触碰 Koffi、DLL、Accent 或临时窗口依赖。

### 隐私

- 用已知 API Key、JWT、Bearer、refresh token、encryption key 和 home path fixture 验证最终报告不包含原文。
- renderer progress payload 不包含原始 Store、headers 或凭证。
- 未知 error message 中夹带 secret 时不会透传。

### UI 与 IPC

- reducer 忽略旧 runId，保持定义顺序。
- `skipped` 不使用红色或失败链接。
- `running` 使用黄色圆形 spinner。
- fail 显示红色、原因和蓝色手册链接。
- 设置入口、preload 白名单和 IPC handler 都有接线测试。
- 真实 Diagnostics preload 无法访问 settings/history/provider/MCP 写通道；主题 projection 不含 cursor、root 或完整 session 文件名。
- rerun 重新读取代理和 Windows capability；同一 run 内 network/provider 使用同一代理 snapshot。
- guide 缺失/打开失败有可见反馈。

### 打包与回归

- `electron-builder.yml` 配置包含 `docs/diagnostics` extraResources。
- 执行 unpacked directory build，确认每个白名单手册实际存在于 `resources/diagnostics-guides`。
- `npm run build:renderer` 通过。
- 完整 `npm test` 通过。
- 从最终 HEAD 重新生成 unpacked artifact，并核对 packed main/preload/package dependencies 与 13 个 guides，而不是复用 merge 前产物。

## 验收标准映射

- 设置入口与独立窗口：Settings action + Diagnostics BrowserWindow。
- 实时颜色与 spinner：runner progress + renderer 状态模块。
- 失败原因与蓝色手册链接：安全 summary + guideId。
- 离线手册：extraResources + 白名单路径解析。
- 无破坏性：独立只读 probes + bytes/Store spy 回归测试。
- 重新运行：active runId 替换与旧事件过滤。
- 复制报告：主进程 report formatter + clipboard。
- 单项失败隔离：runner catch/timeout。
- 不实现自动修复：无任何 mutation IPC 或修复按钮。
- capability-level 只读：Diagnostics 使用独立 preload 和最小主题 projection。
- 真实资源有界：共享 semaphore + abort/deadline 保证跨 rerun active remote 不超过 3。

## 已确认取舍

- 本 PR 实现 Issue #169 的完整 MVP，但不做可选 Acrylic A/B 测试区、自动修复或命令行诊断模式。
- 使用模块化只读探针与实时事件，不复用带写副作用的正常业务入口。
- 安全审查修订以只读约束优先于原共享-preload/`Promise.race`/应用级缓存假设。
- 当前 Codex 托管 worktree 即本任务的新隔离工作树；功能分支从 `origin/main` 创建。
- 完成后推送功能分支并创建以 `main` 为 base 的 PR；不直接在 `main` 上开发。
