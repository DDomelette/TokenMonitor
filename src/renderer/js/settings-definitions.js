window.App = window.App || {};

window.SettingsDefinitions = [
  { group: '窗口', key: 'window.opacity', type: 'slider', label: '透明度', min: 20, max: 100, default: 92, unit: '%' },
  { group: '窗口', key: 'window.alwaysOnTop', type: 'toggle', label: '始终置顶', default: true },
  { group: '窗口', key: 'window.autoLaunch', type: 'toggle', label: '开机自启', default: false },
  { group: '窗口', key: 'window.followSystemTheme', type: 'toggle', label: '跟随系统主题', default: true },
  { group: '窗口', key: 'window.darkMode', type: 'select', label: '主题模式', options: [
    { value: 'system', label: '跟随系统' }, { value: 'dark', label: '夜间模式' }, { value: 'light', label: '日间模式' }
  ], default: 'system' },
  { group: '窗口', key: 'window.layoutLocked', type: 'toggle', label: '锁定布局', default: true },
  { group: '组件', key: 'components.feeCards', type: 'toggle', label: '费用概览卡片', default: true },
  { group: '组件', key: 'components.modelBar', type: 'toggle', label: '模型消耗柱状图', default: true },
  { group: '组件', key: 'components.tokenLine', type: 'toggle', label: 'Token 消耗趋势', default: true },
  { group: '组件', key: 'components.costLine', type: 'toggle', label: '费用增长趋势', default: true },
  { group: '数据', key: 'data.historyDays', type: 'select', label: '历史数据保留', options: [
    { value: 3, label: '3 天' }, { value: 7, label: '7 天' }, { value: 30, label: '30 天' }
  ], default: 7 },
  { group: '关于', key: 'apiKey', type: 'password', label: 'API Key', default: '' }
];
