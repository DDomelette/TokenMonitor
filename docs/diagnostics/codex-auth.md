# Codex 登录凭证排障

## 这个检测项检查什么

检查 Codex 登录凭证状态。

## 常见失败原因

官方登录会话过期或本地凭证文件不可访问。

## 安全检查步骤

运行 Codex 官方登录流程恢复凭证。

## 高风险操作提醒

不要编辑或分享 `auth.json` 中的 token 字段。

## 提交 Issue 时附上什么

仅附上复制出的 Diagnostics report，以及失败检测项的 id 和 error code。
