# Windows GPU 排障

## 这个检测项检查什么

检查 Electron GPU 状态及图形驱动兼容性。

## 常见失败原因

GPU 进程被禁用、驱动不兼容或近期驱动升级造成回归。

## 安全检查步骤

检查 Electron GPU 状态，并从官方来源更新或回退 GPU 驱动。

## 高风险操作提醒

不要为了排障而禁用全局安全功能。

## 提交 Issue 时附上什么

仅附上复制出的 Diagnostics report，以及失败检测项的 id 和 error code。
