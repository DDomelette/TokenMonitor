const VALID_MODES = new Set(['system', 'dark', 'light', 'acrylic-light', 'acrylic-dark']);
const VALID_THEMES = new Set(['light', 'dark', 'acrylic-light', 'acrylic-dark']);

function windowSettings(settings) {
  return settings && settings.window && typeof settings.window === 'object'
    ? settings.window
    : {};
}

export function resolveTheme(settings, systemDark) {
  const values = windowSettings(settings);
  const followSystem = values.followSystemTheme !== false;
  const mode = VALID_MODES.has(values.darkMode) ? values.darkMode : 'system';

  if (followSystem || mode === 'system') {
    return systemDark ? 'dark' : 'light';
  }
  return mode;
}

function setElementTheme(element, theme) {
  if (!element) return;
  const isDark = theme === 'dark' || theme === 'acrylic-dark';
  if (element.dataset) element.dataset.theme = theme;
  if (element.classList && typeof element.classList.toggle === 'function') {
    element.classList.toggle('dark', isDark);
  }
  if (element.style) element.style.colorScheme = theme;
}

export function installThemeSync(options) {
  const opts = options || {};
  const getSettings = opts.getSettings;
  const on = opts.on;
  const mediaQuery = opts.mediaQuery;
  const root = opts.root;
  const body = opts.body;
  const dispatchThemeApplied = typeof opts.dispatchThemeApplied === 'function'
    ? opts.dispatchThemeApplied
    : () => {};

  let disposed = false;
  let settings = null;
  let systemDark = !!(mediaQuery && mediaQuery.matches);
  let currentTheme = null;
  const unsubscribers = [];

  function commit(theme) {
    if (disposed || !VALID_THEMES.has(theme)) return null;
    if (theme === currentTheme) return theme;
    currentTheme = theme;
    setElementTheme(root, theme);
    setElementTheme(body, theme);
    dispatchThemeApplied(theme);
    return theme;
  }

  function recompute(fallbackTheme) {
    if (settings) return commit(resolveTheme(settings, systemDark));
    if (VALID_THEMES.has(fallbackTheme)) {
      return commit(fallbackTheme);
    }
    return null;
  }

  if (typeof on === 'function') {
    const offSettings = on('settings:loaded', (nextSettings) => {
      if (disposed) return;
      settings = nextSettings || {};
      recompute();
    });
    const offTheme = on('theme:changed', (theme) => {
      if (disposed) return;
      // Persisted settings plus the current media query are authoritative.
      // The main-process notification still wakes the renderer immediately.
      recompute(theme);
    });
    if (typeof offSettings === 'function') unsubscribers.push(offSettings);
    if (typeof offTheme === 'function') unsubscribers.push(offTheme);
  }

  const onSystemThemeChange = (event) => {
    if (disposed) return;
    systemDark = !!(event && event.matches);
    recompute();
  };
  if (mediaQuery) {
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onSystemThemeChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(onSystemThemeChange);
    }
  }

  if (typeof getSettings === 'function') {
    Promise.resolve()
      .then(() => getSettings())
      .then((persistedSettings) => {
        if (disposed) return;
        settings = persistedSettings || {};
        recompute();
      })
      .catch(() => {
        if (disposed) return;
        settings = {};
        recompute();
      });
  } else {
    settings = {};
    recompute();
  }

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    if (mediaQuery) {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', onSystemThemeChange);
      } else if (typeof mediaQuery.removeListener === 'function') {
        mediaQuery.removeListener(onSystemThemeChange);
      }
    }
  };
}
