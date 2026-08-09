# Kimi 本地日志排障

## 这个检测项检查什么

检查 `~/.kimi-code/sessions` 和 `wire.jsonl` 是否存在且可读。

## 常见失败原因

会话目录缺失、日志不可读或被清理。

## 安全检查步骤

确认会话目录与 `wire.jsonl` 可读，并仅审查必要片段。

## 高风险操作提醒

未脱敏前，不要上传完整日志。

## 提交 Issue 时附上什么

仅附上复制出的 Diagnostics report，以及失败检测项的 id 和 error code。
