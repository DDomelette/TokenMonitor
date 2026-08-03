// 布局策略纯函数(从 src/renderer/js/layout/layout-policy.js 逐行转 ESM,逻辑零改动)。
// registry 数据源为同目录 components.js;gridstack 渲染层(React)只消费本模块的纯函数结果。
import * as registry from './components.js';

export const VERSION = 7;
export const BREAKPOINT_WIDTH = 640;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function breakpointForWidth(width) {
  return Number(width) < BREAKPOINT_WIDTH ? 'compact' : 'wide';
}

export function columnsForBreakpoint(breakpoint) {
  return 12;
}

function getPresets(id, breakpoint) {
  const component = registry.get(id);
  return component && component.presets[breakpoint]
    ? component.presets[breakpoint]
    : [];
}

export function nearestPreset(id, breakpoint, width, height) {
  const presets = getPresets(id, breakpoint);
  if (!presets.length) return null;

  let targetW = Number(width);
  let targetH = Number(height);
  if (!Number.isFinite(targetW)) targetW = presets[0].w;
  if (!Number.isFinite(targetH)) targetH = presets[0].h;

  let nearest = presets[0];
  let nearestDistance = Infinity;
  presets.forEach(function (preset) {
    const dw = targetW - preset.w;
    const dh = targetH - preset.h;
    const distance = dw * dw + dh * dh;
    if (distance < nearestDistance) {
      nearest = preset;
      nearestDistance = distance;
    }
  });
  return clone(nearest);
}

function closestPreset(presets, width, height) {
  let nearest = presets[0];
  let nearestDistance = Infinity;
  presets.forEach(function (preset) {
    const dw = Number(width) - preset.w;
    const dh = Number(height) - preset.h;
    const distance = dw * dw + dh * dh;
    if (distance < nearestDistance) {
      nearest = preset;
      nearestDistance = distance;
    }
  });
  return clone(nearest);
}

export function presetAfterResize(id, breakpoint, start, current) {
  const presets = getPresets(id, breakpoint);
  if (!presets.length) return null;

  const from = nearestPreset(id, breakpoint, start && start.w, start && start.h);
  if (!from) return null;

  let currentW = Number(current && current.w);
  let currentH = Number(current && current.h);
  if (!Number.isFinite(currentW)) currentW = from.w;
  if (!Number.isFinite(currentH)) currentH = from.h;

  const grewW = currentW > from.w;
  const grewH = currentH > from.h;
  const shrankW = currentW < from.w;
  const shrankH = currentH < from.h;

  let candidates = [];
  if ((grewW || grewH) && !(shrankW || shrankH)) {
    candidates = presets.filter(function (preset) {
      return (!grewW || preset.w > from.w)
        && (!grewH || preset.h > from.h)
        && (!grewW || preset.h >= from.h)
        && (!grewH || preset.w >= from.w);
    });
  } else if ((shrankW || shrankH) && !(grewW || grewH)) {
    candidates = presets.filter(function (preset) {
      return (!shrankW || preset.w < from.w)
        && (!shrankH || preset.h < from.h)
        && (!shrankW || preset.h <= from.h)
        && (!shrankH || preset.w <= from.w);
    });
  }

  return candidates.length
    ? closestPreset(candidates, currentW, currentH)
    : nearestPreset(id, breakpoint, currentW, currentH);
}

function namedPreset(id, breakpoint, name) {
  const preset = getPresets(id, breakpoint).find(function (candidate) {
    return candidate.name === name;
  });
  return preset ? clone(preset) : null;
}

export function overlaps(first, second) {
  return first.x < second.x + second.w
    && first.x + first.w > second.x
    && first.y < second.y + second.h
    && first.y + first.h > second.y;
}

function isFree(item, placed) {
  return !placed.some(function (candidate) {
    return overlaps(item, candidate);
  });
}

export function nearestFreePosition(item, placed, columns) {
  if (isFree(item, placed)) return item;

  const originX = item.x;
  const originY = item.y;
  const placedBottom = placed.reduce(function (maximum, candidate) {
    return Math.max(maximum, candidate.y + candidate.h);
  }, 0);
  const searchBottom = Math.max(originY + item.h, placedBottom) + 100;
  let best = null;
  let bestDistance = Infinity;

  for (let y = 0; y <= searchBottom; y += 1) {
    for (let x = 0; x <= columns - item.w; x += 1) {
      const candidate = Object.assign({}, item, { x: x, y: y });
      if (!isFree(candidate, placed)) continue;
      const distance = Math.abs(originX - x) + Math.abs(originY - y);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }

  return best || Object.assign({}, item, { x: 0, y: placedBottom });
}

function normalizeItem(item, breakpoint, columns) {
  const component = item && registry.get(item.id);
  if (!component) return null;

  const preset = namedPreset(item.id, breakpoint, item.preset)
    || nearestPreset(item.id, breakpoint, item.w, item.h);
  if (!preset) return null;

  return {
    id: item.id,
    x: clamp(finiteInteger(item.x, 0), 0, columns - preset.w),
    y: Math.max(0, finiteInteger(item.y, 0)),
    w: preset.w,
    h: preset.h,
    preset: preset.name
  };
}

export function defaultLayout(breakpoint) {
  const columns = columnsForBreakpoint(breakpoint);
  return {
    columns: columns,
    items: registry.list().map(function (component) {
      return Object.assign({ id: component.id }, clone(component.defaultPlacement[breakpoint]));
    })
  };
}

export function validateLayout(breakpoint, layout) {
  if (!layout || !Array.isArray(layout.items)) return defaultLayout(breakpoint);

  const columns = columnsForBreakpoint(breakpoint);
  const seen = Object.create(null);
  const normalized = [];

  layout.items.forEach(function (item) {
    if (!item || seen[item.id]) return;
    const next = normalizeItem(item, breakpoint, columns);
    if (!next) return;
    seen[item.id] = true;
    normalized.push(nearestFreePosition(next, normalized, columns));
  });

  registry.list().forEach(function (component) {
    if (seen[component.id]) return;
    const fallback = normalizeItem(
      Object.assign({ id: component.id }, component.defaultPlacement[breakpoint]),
      breakpoint,
      columns
    );
    normalized.push(nearestFreePosition(fallback, normalized, columns));
  });

  return { columns: columns, items: normalized };
}

export function migrate(settings) {
  const available = registry.list().map(function (component) { return component.id; });
  const requested = settings && Array.isArray(settings.componentOrder)
    ? settings.componentOrder
    : [];
  const order = requested.filter(function (id, index) {
    return available.indexOf(id) !== -1 && requested.indexOf(id) === index;
  });
  // 缺失组件(新增板块)按注册表顺序插回对应位置,而不是一律追加到末尾
  available.forEach(function (id) {
    if (order.indexOf(id) !== -1) return;
    const registryIndex = available.indexOf(id);
    let insertAt = order.length;
    for (let i = 0; i < order.length; i += 1) {
      if (available.indexOf(order[i]) > registryIndex) {
        insertAt = i;
        break;
      }
    }
    order.splice(insertAt, 0, id);
  });

  const compactColumns = columnsForBreakpoint('compact');
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  const compactItems = order.map(function (id) {
    const component = registry.get(id);
    const placement = clone(component.defaultPlacement.compact);
    if (x > 0 && x + placement.w > compactColumns) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    placement.x = x;
    placement.y = y;
    x += placement.w;
    rowHeight = Math.max(rowHeight, placement.h);
    return Object.assign({ id: id }, placement);
  });

  return {
    version: VERSION,
    compact: { columns: compactColumns, items: compactItems },
    wide: defaultLayout('wide')
  };
}

export function validateState(state, settings) {
  if (!state || Number(state.version) !== VERSION) return migrate(settings || {});
  return {
    version: VERSION,
    compact: validateLayout('compact', state.compact),
    wide: validateLayout('wide', state.wide)
  };
}
