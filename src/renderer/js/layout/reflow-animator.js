(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReflowAnimator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  var positions = new Map();
  var animated = new Set();

  function candidates(container, activeElement) {
    if (!container) return [];
    return Array.from(container.querySelectorAll('.grid-stack-item')).filter(function (element) {
      if (element === activeElement) return false;
      if (element.classList.contains('hidden')) return false;
      if (element.classList.contains('ui-draggable-dragging')) return false;
      if (element.classList.contains('ui-resizable-resizing')) return false;
      return true;
    });
  }

  function capture(container, activeElement) {
    positions.clear();
    candidates(container, activeElement).forEach(function (element) {
      var rect = element.getBoundingClientRect();
      positions.set(element, { left: rect.left, top: rect.top });
    });
  }

  function play(container, activeElement) {
    var schedule = root.requestAnimationFrame || function (callback) {
      return setTimeout(callback, 0);
    };

    candidates(container, activeElement).forEach(function (element) {
      var previous = positions.get(element);
      if (!previous) return;
      var current = element.getBoundingClientRect();
      var dx = previous.left - current.left;
      var dy = previous.top - current.top;
      if (dx === 0 && dy === 0) return;

      element.style.transition = 'none';
      element.style.transform = 'translate3d(' + dx + 'px, ' + dy + 'px, 0)';
      element.classList.add('layout-reflowing');
      animated.add(element);

      schedule(function () {
        element.style.transition = '';
        element.style.transform = '';
      });
    });
  }

  function clear() {
    animated.forEach(function (element) {
      element.style.transition = '';
      element.style.transform = '';
      element.classList.remove('layout-reflowing');
    });
    animated.clear();
    positions.clear();
  }

  return { capture: capture, play: play, clear: clear };
});
