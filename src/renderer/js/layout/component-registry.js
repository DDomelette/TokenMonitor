(function (root, factory) {
  var api = factory();
  root.ComponentRegistry = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // 同类组件只在这里定义一次结构。新组件注册 id、设置键和默认位置，
  // 自动继承渲染器、标题、表面样式、测高与缩放约束；个别差异用显式覆写表达。
  var kindDefinitions = {
    quota: {
      renderer: 'quota',
      itemClass: 'chart-widget',
      surfaceClass: 'embed-surface',
      showTitle: false,
      autoFit: true,
      requiresProvider: true,
      usesChartRange: false,
      minSize: { w: 6, h: 5 },
      presets: [
        { name: 'full', w: 12, h: 7 },
        { name: 'half', w: 6, h: 7 },
        { name: 'tall', w: 12, h: 9 }
      ]
    },
    card: {
      renderer: 'fee',
      itemClass: 'fee-card-widget',
      surfaceClass: 'fee-card-surface',
      showTitle: true,
      autoFit: true,
      requiresProvider: false,
      usesChartRange: false,
      minSize: { w: 4, h: 3 },
      presets: [
        { name: 'card', w: 4, h: 4 },
        { name: 'wide', w: 6, h: 4 }
      ]
    },
    chart: {
      renderer: 'usage-chart',
      itemClass: 'chart-widget',
      surfaceClass: 'chart-surface',
      showTitle: false,
      autoFit: false,
      requiresProvider: false,
      usesChartRange: true,
      minSize: { w: 4, h: 4 },
      presets: [
        // 小卡保留 sparkline 模式；带完整标题、图例与双轴的卡至少 8 格高。
        { name: 'card', w: 4, h: 4 },
        { name: 'half', w: 6, h: 8 },
        { name: 'full', w: 12, h: 8 },
        { name: 'tall', w: 12, h: 10 }
      ]
    },
    heatmap: {
      renderer: 'heatmap',
      itemClass: 'chart-widget',
      surfaceClass: 'chart-surface embed-surface',
      showTitle: false,
      autoFit: true,
      requiresProvider: false,
      usesChartRange: false,
      minSize: { w: 6, h: 10 },
      presets: [
        { name: 'full', w: 12, h: 10 },
        { name: 'half', w: 6, h: 11 },
        { name: 'tall', w: 12, h: 12 }
      ]
    }
  };

  var components = [
    {
      id: 'quota-codex',
      label: 'Codex 额度',
      settingsKey: 'components.quotaCodex',
      kind: 'quota',
      providerId: 'codex',
      placement: { x: 0, y: 0, w: 12, h: 7, preset: 'full' }
    },
    {
      id: 'quota-kimi',
      label: 'Kimi 额度',
      settingsKey: 'components.quotaKimi',
      kind: 'quota',
      providerId: 'kimi',
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
      placement: { x: 0, y: 18, w: 12, h: 8, preset: 'full' }
    },
    {
      id: 'provider-bar',
      label: '每日 Token 消耗',
      settingsKey: 'components.providerBar',
      kind: 'chart',
      renderer: 'provider-bar',
      placement: { x: 0, y: 26, w: 12, h: 8, preset: 'full' }
    },
    {
      id: 'token-speed',
      label: 'Token 消耗速度',
      settingsLabel: 'Token 消耗速度（会增加内存占用）',
      settingsKey: 'components.tokenSpeed',
      defaultVisible: false,
      kind: 'chart',
      renderer: 'token-speed',
      surfaceClass: 'chart-surface embed-surface',
      usesChartRange: false,
      placement: { x: 0, y: 34, w: 12, h: 8, preset: 'full' }
    },
    {
      id: 'token-line',
      label: 'DeepSeek Token 消耗趋势',
      settingsKey: 'components.tokenLine',
      kind: 'chart',
      placement: { x: 0, y: 41, w: 12, h: 8, preset: 'full' }
    },
    {
      id: 'cost-line',
      label: 'DeepSeek 费用增长趋势',
      settingsKey: 'components.costLine',
      kind: 'chart',
      placement: { x: 0, y: 49, w: 12, h: 8, preset: 'full' }
    },
    {
      id: 'token-heatmap',
      label: 'Token 活动',
      settingsKey: 'components.tokenHeatmap',
      kind: 'heatmap',
      placement: { x: 0, y: 57, w: 12, h: 10, preset: 'full' }
    }
  ].map(function (definition) {
    var kind = definition.kind;
    var placement = definition.placement;
    var metadata = Object.assign({}, definition);
    delete metadata.kind;
    delete metadata.placement;
    var defaults = kindDefinitions[kind];
    if (!defaults) throw new Error('Unknown component kind: ' + kind);
    return Object.assign({ defaultVisible: true, resizable: true }, defaults, metadata, {
      kind: kind,
      presets: { compact: defaults.presets, wide: defaults.presets },
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
