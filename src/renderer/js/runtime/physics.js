window._physics = {};

(function () {
  var STIFFNESS = 0.18;
  var DAMPING = 0.82;
  var ws = window._ws;

  function physicsTick() {
    var dx = ws.targetX - ws.x;
    var dy = ws.targetY - ws.y;
    var dw = ws.targetWidth - ws.width;
    var dh = ws.targetHeight - ws.height;

    ws.vx += dx * STIFFNESS;
    ws.vy += dy * STIFFNESS;

    ws.vx *= DAMPING;
    ws.vy *= DAMPING;

    ws.x += ws.vx;
    ws.y += ws.vy;
    ws.width += dw * STIFFNESS;
    ws.height += dh * STIFFNESS;
  }

  window._physics.tick = physicsTick;
})();
