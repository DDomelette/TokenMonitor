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
    var inFlight = [];

    function owns(object, key) {
      return Object.prototype.hasOwnProperty.call(object, key);
    }

    function hasTimer(key) {
      return owns(timers, key);
    }

    function hasPendingValue(key) {
      return owns(pendingValues, key);
    }

    function removeInFlight(operation) {
      var index = inFlight.indexOf(operation);
      if (index !== -1) inFlight.splice(index, 1);
    }

    function emitPending(normalizedKey) {
      if (!hasPendingValue(normalizedKey)) return null;
      if (hasTimer(normalizedKey)) {
        clearTimer(timers[normalizedKey]);
        delete timers[normalizedKey];
      }

      var value = pendingValues[normalizedKey];
      delete pendingValues[normalizedKey];

      var result;
      try {
        result = opts.onEmit(normalizedKey, value);
      } catch (error) {
        result = Promise.reject(error);
      }

      var operation = Promise.resolve(result).then(function (acknowledgement) {
        if (typeof opts.onSuccess === 'function') {
          opts.onSuccess(normalizedKey, value, acknowledgement);
        }
        return acknowledgement;
      }, function (error) {
        // A newer user value for the same key wins. Otherwise restore the failed
        // value so a later close attempt can retry instead of silently losing it.
        if (!hasPendingValue(normalizedKey)) {
          pendingValues[normalizedKey] = value;
        }
        if (typeof opts.onError === 'function') {
          opts.onError(error, normalizedKey, value);
        }
        throw error;
      });

      inFlight.push(operation);
      operation.then(function () {
        removeInFlight(operation);
      }, function () {
        removeInFlight(operation);
      });
      // Timer-triggered writes may reject before close calls flush(). Attach a
      // handler now to prevent an unhandled rejection; flush still observes the
      // original rejected operation while it is active, or the restored value.
      operation.catch(function () {});
      return operation;
    }

    function schedule(key, value) {
      var normalizedKey = String(key);
      if (hasTimer(normalizedKey)) {
        clearTimer(timers[normalizedKey]);
      }

      pendingValues[normalizedKey] = value;
      timers[normalizedKey] = setTimer(function () {
        delete timers[normalizedKey];
        emitPending(normalizedKey);
      }, delay);
    }

    function flush() {
      Object.keys(timers).forEach(function (key) {
        clearTimer(timers[key]);
        delete timers[key];
      });

      function drain() {
        var active = inFlight.slice();
        if (active.length) {
          // Preserve write ordering: an older timer-triggered write must settle
          // before a newer pending value is emitted for the same key.
          return Promise.all(active).then(drain);
        }

        var keys = Object.keys(pendingValues);
        if (!keys.length) return Promise.resolve();
        keys.forEach(emitPending);
        return drain();
      }

      return drain();
    }

    function hasPending() {
      return Object.keys(pendingValues).length > 0 || inFlight.length > 0;
    }

    return {
      schedule: schedule,
      flush: flush,
      hasPending: hasPending
    };
  }

  return {
    createKeyedDebouncer: createKeyedDebouncer
  };
});
