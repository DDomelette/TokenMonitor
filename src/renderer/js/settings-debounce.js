(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SettingsDebounce = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createKeyedDebouncer(options) {
    var opts = options || {};
    if (typeof opts.onEmit !== 'function') {
      throw new TypeError('createKeyedDebouncer requires an onEmit callback');
    }

    var delay = Number.isFinite(opts.delay) && opts.delay >= 0 ? opts.delay : 300;
    var setTimer = typeof opts.setTimeout === 'function' ? opts.setTimeout : setTimeout;
    var clearTimer = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : clearTimeout;
    var timers = Object.create(null);
    var pendingValues = Object.create(null);

    function hasTimer(key) {
      return Object.prototype.hasOwnProperty.call(timers, key);
    }

    function schedule(key, value) {
      var normalizedKey = String(key);
      if (hasTimer(normalizedKey)) {
        clearTimer(timers[normalizedKey]);
      }

      pendingValues[normalizedKey] = value;
      timers[normalizedKey] = setTimer(function () {
        var pendingValue = pendingValues[normalizedKey];
        delete pendingValues[normalizedKey];
        delete timers[normalizedKey];
        opts.onEmit(normalizedKey, pendingValue);
      }, delay);
    }

    return {
      schedule: schedule
    };
  }

  return {
    createKeyedDebouncer: createKeyedDebouncer
  };
});
