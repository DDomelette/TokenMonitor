window.App = window.App || {};

var windowDefinitions = [
  // 透明度滑块已移除:整窗 setOpacity 的分层机制导致缩放露黑边,透视感由 DWM acrylic 提供
  { group: '窗口', key: 'window.alwaysOnTop', type: 'toggle', label: '始终置顶', default: true },
  { group: '窗口', key: 'window.autoLaunch', type: 'toggle', label: '开机自启', default: false },
  { group: '窗口', key: 'window.followSystemTheme', type: 'toggle', label: '跟随系统主题', default: true },
  { group: '窗口', key: 'window.darkMode', type: 'select', label: '主题模式', options: [
    { value: 'system', label: '跟随系统' }, { value: 'dark', label: '夜间模式' }, { value: 'light', label: '日间模式' },
    { value: 'acrylic-light', label: '亚克力(亮)' }, { value: 'acrylic-dark', label: '亚克力(暗)' }
  ], default: 'system' },
  { group: '窗口', key: 'window.layoutLocked', type: 'toggle', label: '锁定布局', default: true },
  { group: '窗口', key: 'window.edgeAutoHide', type: 'toggle', label: '贴边自动隐藏', default: false }
];

var networkDefinitions = [
  {
    group: '网络',
    key: 'providers.proxyUrl',
    type: 'proxy',
    label: '网络代理',
    default: ''
  }
];

var historyDefinitions = [
  { group: '历史数据', key: 'history.sync', type: 'historySync', label: '用量历史同步', default: '' }
];

var componentDefinitions = window.ComponentRegistry.list().map(function (component) {
  return {
    group: '组件',
    key: component.settingsKey,
    type: 'toggle',
    label: component.settingsLabel || component.label,
    default: component.defaultVisible
  };
});

var tokenSpeedDefinitions = [
  {
    group: '数据', key: 'data.tokenSpeed.intervalSeconds', type: 'select',
    label: 'Token 速度统计周期', default: 30,
    visibleWhen: { key: 'components.tokenSpeed', equals: true },
    options: [
      { value: 10, label: '10 秒' }, { value: 20, label: '20 秒' },
      { value: 30, label: '30 秒' }, { value: 60, label: '1 分钟' },
      { value: 180, label: '3 分钟' }, { value: 300, label: '5 分钟' },
      { value: 3600, label: '1 小时' }, { value: 18000, label: '5 小时' }
    ]
  },
  {
    group: '数据', key: 'data.tokenSpeed.providerFilter', type: 'select',
    label: 'Token 速度展示平台', default: 'all',
    visibleWhen: { key: 'components.tokenSpeed', equals: true },
    options: [
      { value: 'all', label: '展示全部' },
      { value: 'deepseek', label: 'DeepSeek' },
      { value: 'codex', label: 'Codex' },
      { value: 'kimi', label: 'Kimi' }
    ]
  }
];

var tailDefinitions = [
  { group: '数据', key: 'data.historyDays', type: 'select', label: '历史数据保留', options: [
    { value: 3, label: '3 天' }, { value: 7, label: '7 天' }, { value: 30, label: '30 天' },
    { value: 90, label: '90 天' }, { value: 180, label: '180 天' }, { value: 365, label: '365 天' }
  ], default: 7 },
  { group: '关于', key: 'apiKey', type: 'credential', label: 'API Key', default: '' }
];

window.SettingsDefinitions = windowDefinitions.concat(
  networkDefinitions,
  historyDefinitions,
  componentDefinitions,
  tokenSpeedDefinitions,
  tailDefinitions
);
