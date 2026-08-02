# DeepSeek Monitor 源码打包设计

**日期:** 2026-06-12
**目标:** 将项目源码打包为 zip，安全发送给他人，同时修复加密密钥硬编码问题

## 背景

用户需要把 DeepSeek Monitor 项目源码打包发送给别人使用。需确保：
1. 不泄露用户的 API Key 和个人数据
2. 源码包可直接解压使用
3. 修复 `store.js` 中硬编码的 `encryptionKey` 安全问题

## 安全分析结论

- 用户的 API Key 存储在系统用户数据目录 (`%APPDATA%/deepseek-monitor/config.json`)，不在项目文件夹内 —— 打包不会泄露
- 源代码中无硬编码的真实凭据
- 唯一问题是 `store.js` 中 `encryptionKey: 'token-monitor-local-dev-key'` 写死，需要修复

## 变更内容

### 1. 修复 `src/main/store.js` — 加密密钥随机化

**当前问题:**
- 第 33 行 `encryptionKey: 'token-monitor-local-dev-key'` 硬编码

**修复方案:**
- 使用 `crypto.randomBytes(32)` 生成 256 位随机密钥
- 持久化到 `app.getPath('userData')/.key` 文件
- 首次运行时生成，后续读取复用
- 每台机器密钥不同，互相无法解密

### 2. 更新 `.gitignore`

追加排除项:
- `config.json` — electron-store 运行时数据
- `history.json` — 聚合器历史数据
- `*.key` — 加密密钥文件

### 3. 创建 `使用说明.md`

内容涵盖:
- 环境要求 (Node.js >= 18, npm)
- 安装与启动
- 获取 DeepSeek API Key
- 基本操作说明

### 4. 打包 zip

使用 PowerShell `Compress-Archive`，排除:
- `build/` — 构建输出
- `dist/` — 分发目录
- `*.log` — 日志文件
- 输出路径: `d:\Deepseek_Monitor.zip`
