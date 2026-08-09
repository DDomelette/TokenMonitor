# Windows Acrylic 排障

## 这个检测项检查什么

检查 Windows Acrylic 透明效果及渲染条件。

## 常见失败原因

Windows 透明效果关闭、显示驱动过旧或临时环境变量影响渲染。

## 安全检查步骤

启用 Windows 透明效果并更新显示驱动；仅在临时启动时用 `DSM_DISABLE_ACCENT=1` 比较回退效果。

## 高风险操作提醒

绝不要导入陌生人提供的注册表文件。

## 提交 Issue 时附上什么

仅附上复制出的 Diagnostics report，以及失败检测项的 id 和 error code。
