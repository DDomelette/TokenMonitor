const VALID_MODES = new Set(['system', 'dark', 'light', 'acrylic-light', 'acrylic-dark']);

function ownValue(source, key) {
  if (!source || typeof source !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch (_) {
    return undefined;
  }
}

function projectDiagnosticsTheme(settings) {
  const windowSettings = ownValue(settings, 'window');
  const darkMode = ownValue(windowSettings, 'darkMode');
  const followSystemTheme = ownValue(windowSettings, 'followSystemTheme');
  return {
    window: {
      darkMode: VALID_MODES.has(darkMode) ? darkMode : 'system',
      followSystemTheme: typeof followSystemTheme === 'boolean' ? followSystemTheme : true
    }
  };
}

module.exports = { projectDiagnosticsTheme };
