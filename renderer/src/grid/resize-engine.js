// 缩放只更新当前节点；碰撞与吸附由 Dashboard 在 resizestop 统一结算。
// 普通拖拽仍走 GridStack 原生 moveNodeCheck，因此换位、碰撞和推动行为不变。
export function applyIsolatedResize(engine, node, options) {
  if (!engine.changedPosConstrain(node, options)) return false;

  const next = Object.assign({}, node, {
    x: Number.isFinite(options.x) ? options.x : node.x,
    y: Number.isFinite(options.y) ? options.y : node.y,
    w: options.w,
    h: options.h
  });
  engine.nodeBoundFix(next, true);

  const keys = ['x', 'y', 'w', 'h'];
  const changed = keys.some((key) => node[key] !== next[key]);
  if (!changed) return false;

  keys.forEach((key) => { node[key] = next[key]; });
  node._dirty = true;
  engine._notify();
  return true;
}

// 最大尺寸直接由注册表预设推导。自动撑高可能高于预设，只有用户继续
// 放大已超过上限的轴才提示，避免正常横向缩放被既有内容高度误报。
export function isResizeBeyondLimits(component, breakpoint, start, current) {
  const presets = component && component.presets && component.presets[breakpoint];
  if (!presets || !presets.length || !start || !current) return false;

  const maxW = Math.max(...presets.map((preset) => preset.w));
  const maxH = Math.max(...presets.map((preset) => preset.h));
  return (current.w > maxW && current.w > start.w)
    || (current.h > maxH && current.h > start.h);
}

export function createResizeIsolatedEngine(GridStack) {
  return class ResizeIsolatedEngine extends GridStack.Engine {
    moveNodeCheck(node, options) {
      if (options && options.resizing) {
        return applyIsolatedResize(this, node, options);
      }
      return super.moveNodeCheck(node, options);
    }
  };
}
