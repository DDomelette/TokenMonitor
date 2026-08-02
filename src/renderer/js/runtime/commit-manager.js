window._commit = {};

(function () {
  var ws = window._ws;
  var commitPending = false;

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function buildPayload(edge) {
    return {
      x: Math.round(ws.targetX),
      y: Math.round(ws.targetY),
      width: Math.round(clamp(ws.targetWidth, ws.minWidth, ws.maxWidth)),
      height: Math.round(clamp(ws.targetHeight, ws.minHeight, ws.maxHeight)),
      edge: edge || null
    };
  }

  function syncWindowState(bounds) {
    if (!bounds) return;
    ws.init(bounds.x, bounds.y, bounds.width, bounds.height);
    ws.vx = 0;
    ws.vy = 0;
  }

  function verifyBounds(expected) {
    window.api.invoke('get:bounds').then(function (bw) {
      if (!bw) return;
      syncWindowState(bw);
      if (!expected) return;
      var ok = true;
      if (expected.x !== undefined) ok = ok && bw.x === expected.x;
      if (expected.y !== undefined) ok = ok && bw.y === expected.y;
      if (expected.width !== undefined) ok = ok && bw.width === expected.width;
      if (expected.height !== undefined) ok = ok && bw.height === expected.height;
      if (!ok) {
        console.warn('[COMMIT VERIFY] mismatch', {
          committed: expected,
          actual: { x: bw.x, y: bw.y, width: bw.width, height: bw.height }
        });
      }
    });
  }

  function commitBounds(edge) {
    commitPending = false;
    var payload = buildPayload(edge);
    syncWindowState(payload);

    window.api.invoke('window:commit', payload).then(function (actualBounds) {
      syncWindowState(actualBounds || payload);
      verifyBounds(actualBounds || payload);
    });
  }

  function schedule(fn) {
    if (commitPending) return;
    commitPending = true;
    requestAnimationFrame(fn);
  }

  window._commit.scheduleBounds = function (edge) {
    schedule(function () { commitBounds(edge); });
  };

  window._commit.schedule = function () {
    window._commit.scheduleBounds();
  };

  window._commit.isPending = function () {
    return commitPending;
  };
})();
