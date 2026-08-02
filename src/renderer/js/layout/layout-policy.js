(function (root, factory) {
  var registry = typeof module === 'object' && module.exports
    ? require('./component-registry')
    : root.ComponentRegistry;
  var api = factory(registry);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LayoutPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (registry) {
  var VERSION = 3;
  var BREAKPOINT_WIDTH = 640;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function finiteInteger(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function breakpointForWidth(width) {
    return Number(width) < BREAKPOINT_WIDTH ? 'compact' : 'wide';
  }

  function columnsForBreakpoint(breakpoint) {
    return 12;
  }

  function getPresets(id, breakpoint) {
    var component = registry.get(id);
    return component && component.presets[breakpoint]
      ? component.presets[breakpoint]
      : [];
  }

  function nearestPreset(id, breakpoint, width, height) {
    var presets = getPresets(id, breakpoint);
    if (!presets.length) return null;

    var targetW = Number(width);
    var targetH = Number(height);
    if (!Number.isFinite(targetW)) targetW = presets[0].w;
    if (!Number.isFinite(targetH)) targetH = presets[0].h;

    var nearest = presets[0];
    var nearestDistance = Infinity;
    presets.forEach(function (preset) {
      var dw = targetW - preset.w;
      var dh = targetH - preset.h;
      var distance = dw * dw + dh * dh;
      if (distance < nearestDistance) {
        nearest = preset;
        nearestDistance = distance;
      }
    });
    return clone(nearest);
  }

  function closestPreset(presets, width, height) {
    var nearest = presets[0];
    var nearestDistance = Infinity;
    presets.forEach(function (preset) {
      var dw = Number(width) - preset.w;
      var dh = Number(height) - preset.h;
      var distance = dw * dw + dh * dh;
      if (distance < nearestDistance) {
        nearest = preset;
        nearestDistance = distance;
      }
    });
    return clone(nearest);
  }

  function presetAfterResize(id, breakpoint, start, current) {
    var presets = getPresets(id, breakpoint);
    if (!presets.length) return null;

    var from = nearestPreset(id, breakpoint, start && start.w, start && start.h);
    if (!from) return null;

    var currentW = Number(current && current.w);
    var currentH = Number(current && current.h);
    if (!Number.isFinite(currentW)) currentW = from.w;
    if (!Number.isFinite(currentH)) currentH = from.h;

    var grewW = currentW > from.w;
    var grewH = currentH > from.h;
    var shrankW = currentW < from.w;
    var shrankH = currentH < from.h;

    var candidates = [];
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
    var preset = getPresets(id, breakpoint).find(function (candidate) {
      return candidate.name === name;
    });
    return preset ? clone(preset) : null;
  }

  function overlaps(first, second) {
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

  function nearestFreePosition(item, placed, columns) {
    if (isFree(item, placed)) return item;

    var originX = item.x;
    var originY = item.y;
    var placedBottom = placed.reduce(function (maximum, candidate) {
      return Math.max(maximum, candidate.y + candidate.h);
    }, 0);
    var searchBottom = Math.max(originY + item.h, placedBottom) + 100;
    var best = null;
    var bestDistance = Infinity;

    for (var y = 0; y <= searchBottom; y += 1) {
      for (var x = 0; x <= columns - item.w; x += 1) {
        var candidate = Object.assign({}, item, { x: x, y: y });
        if (!isFree(candidate, placed)) continue;
        var distance = Math.abs(originX - x) + Math.abs(originY - y);
        if (distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
    }

    return best || Object.assign({}, item, { x: 0, y: placedBottom });
  }

  function normalizeItem(item, breakpoint, columns) {
    var component = item && registry.get(item.id);
    if (!component) return null;

    var preset = namedPreset(item.id, breakpoint, item.preset)
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

  function defaultLayout(breakpoint) {
    var columns = columnsForBreakpoint(breakpoint);
    return {
      columns: columns,
      items: registry.list().map(function (component) {
        return Object.assign({ id: component.id }, clone(component.defaultPlacement[breakpoint]));
      })
    };
  }

  function validateLayout(breakpoint, layout) {
    if (!layout || !Array.isArray(layout.items)) return defaultLayout(breakpoint);

    var columns = columnsForBreakpoint(breakpoint);
    var seen = Object.create(null);
    var normalized = [];

    layout.items.forEach(function (item) {
      if (!item || seen[item.id]) return;
      var next = normalizeItem(item, breakpoint, columns);
      if (!next) return;
      seen[item.id] = true;
      normalized.push(nearestFreePosition(next, normalized, columns));
    });

    registry.list().forEach(function (component) {
      if (seen[component.id]) return;
      var fallback = normalizeItem(
        Object.assign({ id: component.id }, component.defaultPlacement[breakpoint]),
        breakpoint,
        columns
      );
      normalized.push(nearestFreePosition(fallback, normalized, columns));
    });

    return { columns: columns, items: normalized };
  }

  function migrate(settings) {
    var available = registry.list().map(function (component) { return component.id; });
    var requested = settings && Array.isArray(settings.componentOrder)
      ? settings.componentOrder
      : [];
    var order = requested.filter(function (id, index) {
      return available.indexOf(id) !== -1 && requested.indexOf(id) === index;
    });
    available.forEach(function (id) {
      if (order.indexOf(id) === -1) order.push(id);
    });

    var compactColumns = columnsForBreakpoint('compact');
    var x = 0;
    var y = 0;
    var rowHeight = 0;
    var compactItems = order.map(function (id) {
      var component = registry.get(id);
      var placement = clone(component.defaultPlacement.compact);
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

  function validateState(state, settings) {
    if (!state || Number(state.version) !== VERSION) return migrate(settings || {});
    return {
      version: VERSION,
      compact: validateLayout('compact', state.compact),
      wide: validateLayout('wide', state.wide)
    };
  }

  return {
    VERSION: VERSION,
    BREAKPOINT_WIDTH: BREAKPOINT_WIDTH,
    breakpointForWidth: breakpointForWidth,
    columnsForBreakpoint: columnsForBreakpoint,
    defaultLayout: defaultLayout,
    nearestPreset: nearestPreset,
    presetAfterResize: presetAfterResize,
    overlaps: overlaps,
    migrate: migrate,
    validateLayout: validateLayout,
    validateState: validateState
  };
});
