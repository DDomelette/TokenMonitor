# DeepSeek Monitor — 数据源变更 v2

> 日期：2026-06-10  
> 变更：从代理拦截模式切换为 WebView 会话抓取模式

## 变更原因

DeepSeek 平台未公开用量统计 API。唯一自动获取 token 消耗数据的方式是通过浏览器登录后捕获平台内部 API（`/api/v0/usage/cost` 和 `/api/v0/usage/amount`）。这些接口使用浏览器 session token 认证，API Key 无法通过鉴权。

## 新数据流

```
启动应用
  ↓
Electron 创建 session（persist 分区，Cookie 持久化到磁盘）
  ↓
已有 API Key？──→ 是 ──→ 余额 API ✅
  ↓
打开隐藏 WebView → platform.deepseek.com/usage
  ↓
页面加载 → 拦截 /api/v0/usage/cost 和 /api/v0/usage/amount 请求
  ↓
提取 session token（Authorization header）
  ↓
定时拉取（每 5min）→ 解析数据 → 通过 IPC 推送 UI
```

## 新增/修改文件

| 文件 | 变更 |
|------|------|
| `src/main/index.js` | 新增 session 捕获登录流程，移除代理启动 |
| `src/main/fetcher.js` | **新建** — 用 session token 定时拉取用量数据 |
| `src/renderer/login.html` | 新增 WebView 登录引导 |

## 数据解析

从 `/api/v0/usage/cost` 返回中提取：
- 按模型：`PROMPT_TOKEN`, `PROMPT_CACHE_HIT_TOKEN`, `PROMPT_CACHE_MISS_TOKEN`, `RESPONSE_TOKEN`, `REQUEST`
- 累计 token 消耗 = 各模型各类型累加
- 缓存命中率 = CACHE_HIT / (CACHE_HIT + CACHE_MISS)
