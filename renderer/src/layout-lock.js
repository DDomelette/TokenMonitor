export function isLayoutLocked(settings) {
  return !(
    settings
    && settings.window
    && settings.window.layoutLocked === false
  );
}

export function installLayoutLockSync(options) {
  const opts = options || {};
  const getSettings = opts.getSettings;
  const on = opts.on;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

  let disposed = false;
  let liveRevision = 0;
  let unsubscribe = null;

  function apply(settings) {
    if (!disposed) onChange(isLayoutLocked(settings));
  }

  if (typeof on === 'function') {
    unsubscribe = on('settings:loaded', (settings) => {
      if (disposed) return;
      liveRevision += 1;
      apply(settings || {});
    });
  }

  const initialRevision = liveRevision;
  if (typeof getSettings === 'function') {
    Promise.resolve()
      .then(() => getSettings())
      .then((settings) => {
        if (disposed || liveRevision !== initialRevision) return;
        apply(settings || {});
      })
      .catch(() => {
        if (disposed || liveRevision !== initialRevision) return;
        apply({});
      });
  } else {
    apply({});
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (typeof unsubscribe === 'function') unsubscribe();
  };
}
