function abortError() {
  const error = new Error('Diagnostics operation aborted');
  error.code = 'DIAGNOSTIC_ABORTED';
  return error;
}

function createResourceLimiter(limit = 3) {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new TypeError('Resource limiter requires a positive limit');
  }
  const capacity = Math.floor(limit);
  const queue = [];
  let active = 0;

  function makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      drain();
    };
  }

  function grant(waiter) {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    active += 1;
    waiter.resolve(makeRelease());
  }

  function drain() {
    while (active < capacity && queue.length) {
      const waiter = queue.shift();
      if (waiter.signal && waiter.signal.aborted) {
        if (waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
        waiter.reject(abortError());
        continue;
      }
      grant(waiter);
    }
  }

  function acquire(signal) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      if (active < capacity) {
        grant(waiter);
        return;
      }
      if (signal && typeof signal.addEventListener === 'function') {
        waiter.onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          signal.removeEventListener('abort', waiter.onAbort);
          reject(abortError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      queue.push(waiter);
    });
  }

  return Object.freeze({
    acquire,
    get active() { return active; },
    get pending() { return queue.length; }
  });
}

module.exports = { createResourceLimiter };
