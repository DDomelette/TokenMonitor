(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ThemeModeLink = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // "主题模式"与"跟随系统主题"联动:resolveTheme(renderer/src/theme-sync.js)
  // 中 followSystemTheme 是主开关,为 true 时完全忽略 window.darkMode 的手动值。
  // 手动选择夜间/日间模式时必须同时关闭跟随系统,否则选择会被系统主题覆盖。
  function linkedWrites(key, value) {
    if (key !== 'window.darkMode') return [];
    if (value === 'dark' || value === 'light') {
      return [{ key: 'window.followSystemTheme', value: false }];
    }
    if (value === 'system') {
      return [{ key: 'window.followSystemTheme', value: true }];
    }
    return [];
  }

  // 与 renderer/src/theme-sync.js 的 resolveTheme 同一套语义:
  // followSystemTheme 是主开关,为 true 时忽略 darkMode 手动值,跟随系统。
  var VALID_MODES = { system: true, dark: true, light: true };

  function resolveTheme(windowValues, systemDark) {
    var values = windowValues && typeof windowValues === 'object' ? windowValues : {};
    var followSystem = values.followSystemTheme !== false;
    var mode = VALID_MODES[values.darkMode] ? values.darkMode : 'system';
    if (followSystem || mode === 'system') {
      return systemDark ? 'dark' : 'light';
    }
    return mode;
  }

  return { linkedWrites: linkedWrites, resolveTheme: resolveTheme };
});
