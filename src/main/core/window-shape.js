const DEFAULT_WINDOW_RADIUS = 16;

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function normalizedRadius(width, height, radius) {
  return Math.min(
    positiveInteger(radius),
    Math.floor(width / 2),
    Math.floor(height / 2)
  );
}

function rowInset(radius, row) {
  if (radius <= 0) return 0;
  const dy = radius - (row + 0.5);
  const inside = Math.max(0, radius * radius - dy * dy);
  return Math.max(0, Math.ceil(radius - Math.sqrt(inside)));
}

function buildRoundedWindowShape(widthValue, heightValue, radiusValue) {
  const width = positiveInteger(widthValue);
  const height = positiveInteger(heightValue);
  if (!width || !height) return [];

  const requestedRadius = radiusValue === undefined
    ? DEFAULT_WINDOW_RADIUS
    : radiusValue;
  const radius = normalizedRadius(width, height, requestedRadius);
  if (!radius) return [{ x: 0, y: 0, width, height }];

  const rects = [];
  for (let row = 0; row < radius; row += 1) {
    const inset = rowInset(radius, row);
    const spanWidth = width - inset * 2;
    if (spanWidth > 0) {
      rects.push({ x: inset, y: row, width: spanWidth, height: 1 });
    }
  }

  const middleHeight = height - radius * 2;
  if (middleHeight > 0) {
    rects.push({ x: 0, y: radius, width, height: middleHeight });
  }

  for (let row = radius - 1; row >= 0; row -= 1) {
    const inset = rowInset(radius, row);
    const spanWidth = width - inset * 2;
    if (spanWidth > 0) {
      rects.push({
        x: inset,
        y: height - 1 - row,
        width: spanWidth,
        height: 1
      });
    }
  }

  return rects;
}

function applyRoundedWindowShape(win, options) {
  const opts = options || {};
  const platform = opts.platform || process.platform;
  if (platform !== 'win32' && platform !== 'linux') return false;
  if (!win || typeof win.getContentSize !== 'function' || typeof win.setShape !== 'function') {
    return false;
  }

  try {
    const size = win.getContentSize();
    const rects = buildRoundedWindowShape(
      size && size[0],
      size && size[1],
      opts.radius === undefined ? DEFAULT_WINDOW_RADIUS : opts.radius
    );
    if (!rects.length) return false;
    win.setShape(rects);
    return true;
  } catch (error) {
    // setShape is experimental and may be unavailable under some window managers.
    return false;
  }
}

module.exports = {
  DEFAULT_WINDOW_RADIUS,
  buildRoundedWindowShape,
  applyRoundedWindowShape
};
