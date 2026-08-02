# 源码安全打包 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 DeepSeek Monitor 项目源码打包为安全 zip，修复加密密钥硬编码问题，附使用说明

**Architecture:** 4 个独立任务：修复 store.js 加密逻辑 → 完善 .gitignore → 编写使用说明 → 打包 zip。任务间有顺序依赖（修复和文档需在打包前完成）

**Tech Stack:** Node.js, PowerShell Compress-Archive

---

### Task 1: 修复 `store.js` 硬编码加密密钥

**Files:**
- Modify: `src/main/store.js`

- [ ] **Step 1: 替换 store.js 中的加密密钥逻辑**

将 [src/main/store.js](file:///d:/Deepseek_Monitor/src/main/store.js) 完整替换为以下内容：

```javascript
const Store = require('electron-store');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function getEncryptionKey() {
  const keyPath = path.join(app.getPath('userData'), '.key');
  try {
    return fs.readFileSync(keyPath, 'utf-8');
  } catch (e) {
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
  }
}

const defaults = {
  apiKey: '',
  window: {
    x: undefined,
    y: undefined,
    width: 420,
    height: 680,
    opacity: 92,
    alwaysOnTop: true,
    autoLaunch: false,
    followSystemTheme: true,
    layoutLocked: true
  },
  components: {
    feeCards: true,
    modelBar: true,
    tokenLine: true,
    costLine: true
  },
  componentOrder: ['fee-cards', 'model-bar', 'token-line', 'cost-line'],
  data: {
    sampleInterval: 30,
    defaultTimeRange: '1h',
    proxyPort: 7890,
    historyDays: 7
  }
};

const store = new Store({
  defaults,
  encryptionKey: getEncryptionKey()
});

module.exports = store;
```

- [ ] **Step 2: 运行 lint 检查**

```powershell
npx eslint src/main/store.js --fix
```

如果项目未配置 ESLint，跳过此步骤。

- [ ] **Step 3: Commit**

```powershell
git add src/main/store.js
git commit -m "fix: replace hardcoded encryption key with per-machine random key"
```

---

### Task 2: 完善 `.gitignore`

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: 追加排除规则**

将 `.gitignore` 追加以下内容：

```
config.json
history.json
*.key
```

- [ ] **Step 2: Commit**

```powershell
git add .gitignore
git commit -m "chore: add config.json, history.json, *.key to gitignore"
```

---

### Task 3: 编写使用说明

**Files:**
- Create: `使用说明.md`

- [ ] **Step 1: 创建使用说明**

创建 `使用说明.md`，内容如下：

```markdown
# DeepSeek Monitor 使用说明

DeepSeek API 用量监控悬浮窗 —— 实时查看 API 余额和调用量。

## 环境要求

- **Node.js** >= 18（推荐 20+）
- **npm** >= 9

## 安装

```bash
cd deepseek-monitor
npm install
```

## 启动

```bash
npm start
```

## 使用步骤

### 1. 输入 API Key

启动后会自动弹出登录窗口，输入你的 DeepSeek API Key（以 `sk-` 开头）。

> 在 [DeepSeek 开发者平台](https://platform.deepseek.com/api_keys) 创建和获取 API Key。

### 2. 登录平台获取用量

输入 API Key 后，会自动打开 DeepSeek 用量页面，完成平台登录即可获取详细用量数据。

### 3. 悬浮窗显示

- 桌面显示透明悬浮窗，实时展示余额和用量曲线
- 右键点击系统托盘图标可显示/隐藏悬浮窗、重新登录、打开设置或退出

### 4. 设置

- 在悬浮窗中打开设置面板
- 可调整：窗口透明度、置顶、暗色模式、自启动、组件排序等

## 常见问题

**Q: 悬浮窗不显示用量？**
A: 请通过托盘菜单选择"重新登录平台"，重新完成平台登录。

**Q: 余额显示异常？**
A: 请确认 API Key 正确且有余额查询权限。

**Q: 窗口位置跑偏？**
A: 在设置面板中重置所有设置即可恢复默认。

## 技术栈

- Electron 28
- ECharts 5
- electron-store 8
```

- [ ] **Step 2: Commit**

```powershell
git add 使用说明.md
git commit -m "docs: add usage guide for recipients"
```

---

### Task 4: 打包 zip

**Files:**
- Output: `d:\Deepseek_Monitor.zip`

- [ ] **Step 1: 执行打包命令**

```powershell
Compress-Archive -Path "d:\Deepseek_Monitor\*" -DestinationPath "d:\Deepseek_Monitor.zip" -CompressionLevel Optimal -Force
```

- [ ] **Step 2: 验证 zip 包完整性**

```powershell
# 查看 zip 内容，确认无 build/、dist/ 等目录
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::OpenRead("d:\Deepseek_Monitor.zip").Entries | Select-Object FullName, Length | Format-Table -AutoSize
```

- [ ] **Step 3: 完成**

zip 包位于 `d:\Deepseek_Monitor.zip`，可直接发送给他人。
