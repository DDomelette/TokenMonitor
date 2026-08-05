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

  return { linkedWrites: linkedWrites };
});
