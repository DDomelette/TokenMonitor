# 加密密钥迁移——崩溃修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复随机密钥导致旧 config.json 解密失败的应用崩溃

**Architecture:** 2 个独立任务：加 `clearInvalidConfig: true` → 删除用户本地旧数据。任务间无严格依赖但建议按序执行。

**Tech Stack:** Electron, electron-store

---

### Task 1: store.js 加 `clearInvalidConfig: true`

**Files:**
- Modify: `src/main/store.js:50-53`

- [ ] **Step 1: 在 Store 配置中加上 clearInvalidConfig**

将 `src/main/store.js` 第 50-53 行从：

```js
const store = new Store({
  defaults,
  encryptionKey: getEncryptionKey()
});
```

改为：

```js
const store = new Store({
  defaults,
  encryptionKey: getEncryptionKey(),
  clearInvalidConfig: true
});
```

- [ ] **Step 2: 验证语法**

```powershell
node -c "d:\Deepseek_Monitor\src\main\store.js"
```

- [ ] **Step 3: Commit**

```powershell
git add src/main/store.js
git commit -m "fix: add clearInvalidConfig to handle corrupted config files gracefully"
```

---

### Task 2: 删除用户本地旧数据

**Files:**
- Delete: `%APPDATA%\deepseek-monitor\config.json`（旧密钥加密，不可恢复）
- Delete: `%APPDATA%\deepseek-monitor\.key`（让下次启动重新生成）

- [ ] **Step 1: 删除旧文件**

```powershell
Remove-Item "$env:APPDATA\deepseek-monitor\config.json" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\deepseek-monitor\.key" -Force -ErrorAction SilentlyContinue
```

- [ ] **Step 2: 验证文件已删除**

```powershell
if (Test-Path "$env:APPDATA\deepseek-monitor\config.json") { Write-Host "config.json still exists" } else { Write-Host "config.json deleted OK" }
if (Test-Path "$env:APPDATA\deepseek-monitor\.key") { Write-Host ".key still exists" } else { Write-Host ".key deleted OK" }
```

- [ ] **Step 3: 启动验证**

```powershell
npm start
```

确认应用正常启动，不再报 JSON 解析错误。
