# 加密密钥迁移——崩溃修复

**日期:** 2026-06-12
**目标:** 修复随机密钥方案导致旧 config.json 解密失败的崩溃

## 背景

上一轮将 [store.js](file:///d:/Deepseek_Monitor/src/main/store.js) 的硬编码 `encryptionKey` 替换为 `getEncryptionKey()` 随机生成后，用户本地的 `config.json` 仍是用旧密钥 `token-monitor-local-dev-key` 加密的。electron-store 用新密钥解密失败 → JSON 乱码 → `JSON.parse` 崩溃 → 整个应用无法启动。

## 修复设计

### 1. store.js 加 `clearInvalidConfig: true`

electron-store 内置选项，当 config.json 内容无效时自动重置为默认配置，不抛异常。

原来：
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

### 2. 删除用户本地旧数据

在用户机器上删除：
- `%APPDATA%\deepseek-monitor\config.json` — 旧密钥加密的文件
- `%APPDATA%\deepseek-monitor\.key` — 让下次启动重新生成

下次启动：生成新随机密钥 → config.json 不存在 → electron-store 用默认值创建 → 正常启动。

### 变更范围

| 文件 | 操作 |
|------|------|
| `src/main/store.js` | 加 `clearInvalidConfig: true` |
| `%APPDATA%\deepseek-monitor\config.json` | 删除 |
| `%APPDATA%\deepseek-monitor\.key` | 删除 |
