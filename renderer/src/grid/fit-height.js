// GridStack 自动测高只处理真实内容溢出。
// 无溢出时必须回到布局基准,不能把已被撑高的 content 高度当成下一次需求,
// 否则 host ResizeObserver 与 grid.update 会形成正反馈,模块持续增长。
export function fitGridItemHeight({ base, cell, padding, scrollHeight, clientHeight }) {
  const safeBase = Number.isFinite(base) && base > 0 ? Math.ceil(base) : 1;
  if (!Number.isFinite(cell) || cell <= 0) return safeBase;
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return safeBase;
  if (scrollHeight <= clientHeight + 1) return safeBase;

  const pad = Number.isFinite(padding) ? padding : 0;
  const needed = Math.ceil((scrollHeight + pad) / cell);
  return Math.max(safeBase, needed);
}
