// 迷你窗额度圆环的共享纯逻辑：窗口归一、排序与 SVG 几何。
// 所有平台都使用同一套规则，不在具体平台组件中分别设置内外环。

export const RING_RADIUS = 17;
export const RING_CENTER = 22;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// 两段：顶部 120°，底部名义 240°；两个交界处各留 10° 隔断。
// 三段：每段名义 120°；实际 110° 弧 + 10° 隔断。
export const RING_SLOTS = Object.freeze({
  two: Object.freeze([
    Object.freeze({ start: -150, end: -30 }),
    Object.freeze({ start: -20, end: 200 })
  ]),
  three: Object.freeze([
    Object.freeze({ start: -145, end: -35 }),
    Object.freeze({ start: -25, end: 85 }),
    Object.freeze({ start: 95, end: 205 })
  ])
});

const WINDOW_ORDER = Object.freeze({ '5h': 0, weekly: 1, monthly: 2 });
const WINDOW_LABELS = Object.freeze({ '5h': '5 小时额度', weekly: '周额度', monthly: '月额度' });

// 剩余比例（0–1）；无有效数据时返回 null，仅画灰色轨道。
export function remainingFraction(win) {
  if (!win) return null;
  const limit = Number(win.limit);
  const remaining = Number(win.remaining);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null;
  return Math.max(0, Math.min(1, remaining / limit));
}

// 只展示主额度窗口，忽略 Codex Spark 等带 name 的附加限额。
// 输入可以是任意顺序，输出固定为 5h → weekly → monthly。
export function quotaSegments(provider) {
  const windows = provider && provider.quota && Array.isArray(provider.quota.windows)
    ? provider.quota.windows
    : [];
  const mainByKind = new Map();
  windows.forEach((win) => {
    if (!win || win.name || !Object.hasOwn(WINDOW_ORDER, win.kind) || mainByKind.has(win.kind)) return;
    mainByKind.set(win.kind, win);
  });
  return [...mainByKind.values()]
    .sort((a, b) => WINDOW_ORDER[a.kind] - WINDOW_ORDER[b.kind])
    .map((win) => ({
      key: win.kind,
      label: WINDOW_LABELS[win.kind],
      frac: remainingFraction(win)
    }));
}

export function ringPoint(angle, radius = RING_RADIUS) {
  const radians = angle * Math.PI / 180;
  return {
    x: RING_CENTER + radius * Math.cos(radians),
    y: RING_CENTER + radius * Math.sin(radians)
  };
}

export function ringArcPath(start, end) {
  const from = ringPoint(start);
  const to = ringPoint(end);
  const largeArc = end - start > 180 ? 1 : 0;
  return `M ${from.x.toFixed(3)} ${from.y.toFixed(3)} A ${RING_RADIUS} ${RING_RADIUS} 0 ${largeArc} 1 ${to.x.toFixed(3)} ${to.y.toFixed(3)}`;
}
