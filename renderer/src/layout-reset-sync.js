function isLayoutMissing(settings) {
  return !settings || settings.layout === null || settings.layout === undefined;
}

export function installLayoutResetSync(options) {
  const opts = options || {};
  const getSettings = opts.getSettings;
  const on = opts.on;
  const onReset = typeof opts.onReset === 'function' ? opts.onReset : () => {};

  let disposed = false;
  let liveRevision = 0;
  let layoutMissing = null;
  let unsubscribe = null;

  function observe(settings, source) {
    if (disposed) return;
    const missing = isLayoutMissing(settings);
    const shouldReset = missing && (
      layoutMissing === false
      || (source === 'live' && layoutMissing === null)
    );
    layoutMissing = missing;
    if (shouldReset) onReset();
  }

  if (typeof on === 'function') {
    unsubscribe = on('settings:loaded', (settings) => {
      if (disposed) return;
      liveRevision += 1;
      observe(settings || {}, 'live');
    });
  }

  const initialRevision = liveRevision;
  if (typeof getSettings === 'function') {
    Promise.resolve()
      .then(() => getSettings())
      .then((settings) => {
        if (disposed || liveRevision !== initialRevision) return;
        observe(settings || {}, 'initial');
      })
      .catch(() => {
        // A settings read failure is not evidence of an intentional reset.
      });
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof unsubscribe === 'function') unsubscribe();
  };
}
