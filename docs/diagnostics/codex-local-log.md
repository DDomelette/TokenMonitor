# Codex 本地日志排障

## 这个检测项检查什么

检查 `~/.codex/sessions` 是否存在且可读。

## 归档日志与用量重建

Codex 会话系统会把旧的 rollout 移入 `~/.codex/archived_sessions`。应用在升级后首次启动时会自动用活动与归档两个目录的全部 rollout 事件级去重重建 Codex 历史用量:

- 迁移期间旧统计保持可见,迁移成功前不修改旧数据。
- 迁移失败不修改旧数据、旧游标或迁移标记,当前进程退回仅扫描活动目录的兼容模式,并在下次启动重试。
- 日常扫描同时覆盖两个目录,rollout 在目录间移动后按稳定 UUID 从原 offset 续扫。
- 自定义活动目录沿用 `providers.codex.localLogRoot`;自定义归档目录仅在显式设置 `providers.codex.archivedLogRoot` 时启用。

只读验收(不写 store、不改日志):

```bash
npm run verify:codex-archive-usage -- --date 2026-08-09
```

## 常见失败原因

会话目录缺失、权限不足或日志已被清理。

## 安全检查步骤

只确认目录可读并检查必要日志片段。

## 高风险操作提醒

未审查敏感提示词前，不要上传完整 rollout 日志。

## 提交 Issue 时附上什么

仅附上复制出的 Diagnostics report，以及失败检测项的 id 和 error code。