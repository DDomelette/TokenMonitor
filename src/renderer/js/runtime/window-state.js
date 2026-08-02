window._ws = {
  x: 0, y: 0, width: 420, height: 680,
  targetX: 0, targetY: 0, targetWidth: 420, targetHeight: 680,
  vx: 0, vy: 0,
  dragging: false,
  resizing: false,
  resizeEdge: null,
  minWidth: 380,
  minHeight: 200,
  maxWidth: 2400,
  maxHeight: 1600,
  constraintHit: false,
  constraintHits: 0,
  lastConstraintRule: null
};

window._ws.init = function (x, y, w, h) {
  window._ws.x = x; window._ws.y = y;
  window._ws.width = w; window._ws.height = h;
  window._ws.targetX = x; window._ws.targetY = y;
  window._ws.targetWidth = w; window._ws.targetHeight = h;
};
