(function (root, factory) {
  var api = factory();
  root.ComponentRegistry = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // 同类组件共用尺寸模板;两种断点输出保持原来的独立可编辑结构。
  var presetGroups = {
    quota: [
      { name: 'full', w: 12, h: 7 },
      { name: 'half', w: 6, h: 7 },
      { name: 'tall', w: 12, h: 9 }
    ],
    card: [
      { name: 'card', w: 4, h: 4 },
      { name: 'wide', w: 6, h: 4 }
    ],
    chart: [
      { name: 'card', w: 4, h: 4 },
      { name: 'half', w: 6, h: 6 },
      { name: 'full', w: 12, h: 6 },
      { name: 'tall', w: 12, h: 8 }
    ],
    speed: [
      { name: 'card', w: 4, h: 4 },
      { name: 'half', w: 6, h: 6 },
      { name: 'full', w: 12, h: 7 },
      { name: 'tall', w: 12, h: 9 }
    ],
    heatmap: [
      { name: 'full', w: 12, h: 10 },
      { name: 'half', w: 6, h: 11 },
      { name: 'tall', w: 12, h: 12 }
    ]
  };
  var components = [
    {
      id: 'quota-codex',
      label: 'Codex 额度',
      settingsKey: 'components.quotaCodex',
      kind: 'quota',
      placement: { x: 0, y: 0, w: 12, h: 7, preset: 'full' }
    },
    {
      id: 'quota-kimi',
      label: 'Kimi 额度',
      settingsKey: 'components.quotaKimi',
      kind: 'quota',
      placement: { x: 0, y: 7, w: 12, h: 7, preset: 'full' }
    },
    {
      id: 'balance-card',
      label: '余额',
      settingsKey: 'components.balanceCard',
      aspectRatio: 1,
      kind: 'card',
      placement: { x: 0, y: 14, w: 4, h: 4, preset: 'card' }
    },
    {
      id: 'today-cost-card',
      label: '今日消耗',
      settingsKey: 'components.todayCostCard',
      aspectRatio: 1,
      kind: 'card',
      placement: { x: 4, y: 14, w: 4, h: 4, preset: 'card' }
    },
    {
      id: 'cache-rate-card',
      label: '缓存命中率',
      settingsKey: 'components.cacheRateCard',
      aspectRatio: 1,
      kind: 'card',
      placement: { x: 8, y: 14, w: 4, h: 4, preset: 'card' }
    },
    {
      id: 'model-bar',
      label: 'DeepSeek 每日 Token 消耗',
      settingsKey: 'components.modelBar',
      kind: 'chart',
      placement: { x: 0, y: 18, w: 12, h: 6, preset: 'full' }
    },
    {
      id: 'provider-bar',
      label: '每日 Token 消耗',
      settingsKey: 'components.providerBar',
      kind: 'chart',
      placement: { x: 0, y: 24, w: 12, h: 6, preset: 'full' }
    },
    {
      id: 'token-speed',
      label: 'Token 消耗速度',
      settingsLabel: 'Token 消耗速度（会增加内存占用）',
      settingsKey: 'components.tokenSpeed',
      defaultVisible: false,
      kind: 'speed',
      placement: { x: 0, y: 30, w: 12, h: 7, preset: 'full' }
    },
    {
      id: 'token-line',
      label: 'DeepSeek Token 消耗趋势',
      settingsKey: 'components.tokenLine',
      kind: 'chart',
      placement: { x: 0, y: 37, w: 12, h: 6, preset: 'full' }
    },
    {
      id: 'cost-line',
      label: 'DeepSeek 费用增长趋势',
      settingsKey: 'components.costLine',
      kind: 'chart',
      placement: { x: 0, y: 43, w: 12, h: 6, preset: 'full' }
    },
    {
      id: 'token-heatmap',
      label: 'Token 活动',
      settingsKey: 'components.tokenHeatmap',
      kind: 'heatmap',
      placement: { x: 0, y: 49, w: 12, h: 10, preset: 'full' }
    }
  ].map(function (definition) {
    var { kind, placement, ...metadata } = definition;
    return Object.assign({ defaultVisible: true }, metadata, {
      presets: { compact: presetGroups[kind], wide: presetGroups[kind] },
      defaultPlacement: { compact: placement, wide: placement }
    });
  });
  var runtime = Object.create(null);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function list() {
    return clone(components);
  }

  function get(id) {
    var component = components.find(function (candidate) {
      return candidate.id === id;
    });
    return component ? clone(component) : null;
  }

  function registerRuntime(id, hooks) {
    if (!get(id)) throw new Error('Unknown component: ' + id);
    runtime[id] = hooks || {};
  }

  function getRuntime(id) {
    return runtime[id] || null;
  }

  return {
    list: list,
    get: get,
    registerRuntime: registerRuntime,
    getRuntime: getRuntime
  };
});
