// 悬浮层统一定位原语(纯函数,无 React/ECharts 依赖):
// clampToWindow 钳制进窗口;resolveVerticalFlip 统一上/下展开判定;
// echartsWindowPosition 是 echarts tooltip position 回调(挂 body 时用)。
// 背景:token-speed 卡片 tooltip 未钳制顶出窗口被裁;各模块自写钳制/翻转,规则漂移。

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function clampToWindow(x, y, width, height, margin = 8) {
  const vp = viewport();
  return {
    x: Math.max(margin, Math.min(vp.width - width - margin, x)),
    y: Math.max(margin, Math.min(vp.height - height - margin, y))
  };
}

// prefer 'below'(默认):下方够就放下面,或上方不够也放下面(CustomSelect/ECharts 风格)
// prefer 'above':默认放上面,上方放不下且下方够才放下面(热力图风格)
function resolveVerticalFlip(anchorRect, contentHeight, options = {}) {
  const gap = options.gap === undefined ? 6 : options.gap;
  const margin = options.margin === undefined ? 8 : options.margin;
  const prefer = options.prefer || 'below';
  const vp = viewport();
  const aboveFits = anchorRect.top - gap - contentHeight >= margin;
  const belowFits = vp.height - anchorRect.bottom - gap - contentHeight >= margin;
  const below = prefer === 'above' ? (!aboveFits && belowFits) : (belowFits || !aboveFits);
  return {
    below,
    top: below ? anchorRect.bottom + gap : anchorRect.top - gap - contentHeight
  };
}

// pos 是图表容器坐标:换算成页面坐标钳制后再减回容器偏移
// (echarts appendToBody 时会再做一次容器→页面换算)。被遮挡时先向反侧翻,再钳制。
function echartsWindowPosition(dom) {
  return (pos, params, tipEl, rect, size) => {
    const chartRect = dom ? dom.getBoundingClientRect() : { left: 0, top: 0 };
    const cw = size.contentSize[0];
    const ch = size.contentSize[1];
    const vp = viewport();
    let px = chartRect.left + pos[0] + 14;
    let py = chartRect.top + pos[1] + 14;
    if (px + cw > vp.width - 8) px = chartRect.left + pos[0] - cw - 14;
    if (py + ch > vp.height - 8) py = chartRect.top + pos[1] - ch - 14;
    const clamped = clampToWindow(px, py, cw, ch);
    return [clamped.x - chartRect.left, clamped.y - chartRect.top];
  };
}

export { clampToWindow, resolveVerticalFlip, echartsWindowPosition };
