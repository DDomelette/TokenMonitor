// GridStack 自动测高只处理真实内容溢出。
// 已测得的 retainedHeight 防止"基准高度溢出→增高→无溢出又回基准"的循环;
// 内容、主题或宽度变化时由调用方清除该值,重新探测是否可以缩回基准。
export function fitGridItemHeight({ base, cell, padding, scrollHeight, clientHeight, retainedHeight }) {
  const safeBase = Number.isFinite(base) && base > 0 ? Math.ceil(base) : 1;
  const safeRetained = Number.isFinite(retainedHeight) && retainedHeight > 0 ? Math.ceil(retainedHeight) : 1;
  const minimum = Math.max(safeBase, safeRetained);
  if (!Number.isFinite(cell) || cell <= 0) return minimum;
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight)) return minimum;
  if (scrollHeight <= clientHeight + 1) return minimum;

  const pad = Number.isFinite(padding) ? padding : 0;
  const needed = Math.ceil((scrollHeight + pad) / cell);
  return Math.max(minimum, needed);
}

// 自动测高不能把 GridStack 动画的中间尺寸误判为新的内容溢出。
// 仅自动修正跳过动画;用户拖拽/缩放仍保留原有动画。
export function applyGridItemHeights(grid, host, updates) {
  if (!updates || updates.length === 0) return;
  const restoreAnimation = Boolean(grid.opts && grid.opts.animate);
  if (restoreAnimation) grid.setAnimation(false);
  try {
    updates.forEach(({ itemEl, h }) => grid.update(itemEl, { h }));
    // 在恢复动画类之前强制提交最终尺寸,避免浏览器把两帧合并成过渡。
    void host.offsetHeight;
  } finally {
    if (restoreAnimation) grid.setAnimation(true, true);
  }
}
