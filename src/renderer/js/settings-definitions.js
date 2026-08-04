window.App = window.App || {};

var windowDefinitions = [
  // 透明度滑块已移除:整窗 setOpacity 的分层机制导致缩放露黑边,透视感由 DWM acrylic 提供
  { group: '窗口', key: 'window.alwaysOnTop', type: 'toggle', label: '始终置顶', default: true },
  { group: '窗口', key: 'window.autoLaunch', type: 'toggle', label: '开机自启', default: false },
  { group: '窗口', key: 'window.followSystemTheme', type: 'toggle', label: '跟随系统主题', default: true },
  { group: '窗口', key: 'window.darkMode', type: 'select', label: '主题模式', options: [
    { value: 'system', label: '跟随系统' }, { value: 'dark', label: '夜间模式' }, { value: 'light', label: '日间模式' }
  ], default: 'system' },
  { group: '窗口', key: 'window.layoutLocked', type: 'toggle', label: '锁定布局', default: true }
];

var componentDefinitions = window.ComponentRegistry.list().map(function (component) {
  return {
    group: '组件',
    key: component.settingsKey,
    type: 'toggle',
    label: component.label,
    default: component.defaultVisible
  };
});

var tailDefinitions = [
  { group: '数据', key: 'data.historyDays', type: 'select', label: '历史数据保留', options: [
    { value: 3, label: '3 天' }, { value: 7, label: '7 天' }, { value: 30, label: '30 天' }
  ], default: 7 },
  { group: '关于', key: 'apiKey', type: 'password', label: 'API Key', default: '' }
];

window.SettingsDefinitions = windowDefinitions.concat(componentDefinitions, tailDefinitions);
