window._runtime = {};

(function () {
  var running = false;
  var onTickCallbacks = [];

  function loop() {
    if (!running) return;
    window._constraint.apply();
    window._physics.tick();
    for (var i = 0; i < onTickCallbacks.length; i++) {
      onTickCallbacks[i]();
    }
    requestAnimationFrame(loop);
  }

  window._runtime.start = function () {
    if (running) return;
    running = true;
    loop();
  };

  window._runtime.onTick = function (fn) {
    onTickCallbacks.push(fn);
  };
})();
