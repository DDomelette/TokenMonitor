(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ComponentRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var components = [
    {
      id: 'balance-card',
      label: '余额',
      settingsKey: 'components.balanceCard',
      defaultVisible: true,
      aspectRatio: 1,
      presets: {
        compact: [
          { name: 'card', w: 4, h: 4 },
          { name: 'wide', w: 6, h: 4 }
        ],
        wide: [
          { name: 'card', w: 4, h: 4 },
          { name: 'wide', w: 6, h: 4 }
        ]
      },
      defaultPlacement: {
        compact: { x: 0, y: 0, w: 4, h: 4, preset: 'card' },
        wide: { x: 0, y: 0, w: 4, h: 4, preset: 'card' }
      }
    },
    {
      id: 'today-cost-card',
      label: '今日消耗',
      settingsKey: 'components.todayCostCard',
      defaultVisible: true,
      aspectRatio: 1,
      presets: {
        compact: [
          { name: 'card', w: 4, h: 4 },
          { name: 'wide', w: 6, h: 4 }
        ],
        wide: [
          { name: 'card', w: 4, h: 4 },
          { name: 'wide', w: 6, h: 4 }
        ]
      },
      defaultPlacement: {
        compact: { x: 4, y: 0, w: 4, h: 4, preset: 'card' },
        wide: { x: 4, y: 0, w: 4, h: 4, preset: 'card' }
      }
    },
    {
      id: 'cache-rate-card',
      label: '缓存命中率',
      settingsKey: 'components.cacheRateCard',
      defaultVisible: true,
      aspectRatio: 1,
      presets: {
        compact: [
          { name: 'card', w: 4, h: 4 },
          { name: 'wide', w: 6, h: 4 }
        ],
        wide: [
          { name: 'card', w: 4, h: 4 },
          { name: 'wide', w: 6, h: 4 }
        ]
      },
      defaultPlacement: {
        compact: { x: 8, y: 0, w: 4, h: 4, preset: 'card' },
        wide: { x: 8, y: 0, w: 4, h: 4, preset: 'card' }
      }
    },
    {
      id: 'model-bar',
      label: 'DeepSeek 每日 Token 消耗',
      settingsKey: 'components.modelBar',
      defaultVisible: true,
      presets: {
        compact: [
          { name: 'card', w: 4, h: 4 },
          { name: 'half', w: 6, h: 6 },
          { name: 'full', w: 12, h: 6 },
          { name: 'tall', w: 12, h: 8 }
        ],
        wide: [
          { name: 'card', w: 4, h: 4 },
          { name: 'half', w: 6, h: 6 },
          { name: 'full', w: 12, h: 6 },
          { name: 'tall', w: 12, h: 8 }
        ]
      },
      defaultPlacement: {
        compact: { x: 0, y: 4, w: 12, h: 6, preset: 'full' },
        wide: { x: 0, y: 4, w: 12, h: 6, preset: 'full' }
      }
    },
    {
      id: 'provider-bar',
      label: '每日 Token 消耗',
      settingsKey: 'components.providerBar',
      defaultVisible: true,
      presets: {
        compact: [
          { name: 'card', w: 4, h: 4 },
          { name: 'half', w: 6, h: 6 },
          { name: 'full', w: 12, h: 6 },
          { name: 'tall', w: 12, h: 8 }
        ],
        wide: [
          { name: 'card', w: 4, h: 4 },
          { name: 'half', w: 6, h: 6 },
          { name: 'full', w: 12, h: 6 },
          { name: 'tall', w: 12, h: 8 }
        ]
      },
      defaultPlacement: {
        compact: { x: 0, y: 10, w: 12, h: 6, preset: 'full' },
        wide: { x: 0, y: 10, w: 12, h: 6, preset: 'full' }
      }
    },
    {
      id: 'token-line',
      label: 'Token 消耗趋势',
      settingsKey: 'components.tokenLine',
      defaultVisible: true,
      presets: {
        compact: [
          { name: 'card', w: 4, h: 4 },
          { name: 'half', w: 6, h: 6 },
          { name: 'full', w: 12, h: 6 },
          { name: 'tall', w: 12, h: 8 }
        ],
        wide: [
          { name: 'card', w: 4, h: 4 },
          { name: 'half', w: 6, h: 6 },
          { name: 'full', w: 12, h: 6 },
          { name: 'tall', w: 12, h: 8 }
        ]
      },
      defaultPlacement: {
        compact: { x: 0, y: 13, w: 12, h: 6, preset: 'full' },
        wide: { x: 0, y: 13, w: 12, h: 6, preset: 'full' }
      }
    },
    {
      id: 'cost-line',
      label: '费用增长趋势',
      settingsKey: 'components.costLine',
      defaultVisible: true,
      presets: {
        compact: [
          { name: 'card', w: 4, h: 4 },
          { name: 'half', w: 6, h: 6 },
          { name: 'full', w: 12, h: 6 },
          { name: 'tall', w: 12, h: 8 }
        ],
        wide: [
          { name: 'card', w: 4, h: 4 },
          { name: 'half', w: 6, h: 6 },
          { name: 'full', w: 12, h: 6 },
          { name: 'tall', w: 12, h: 8 }
        ]
      },
      defaultPlacement: {
        compact: { x: 0, y: 22, w: 12, h: 6, preset: 'full' },
        wide: { x: 0, y: 22, w: 12, h: 6, preset: 'full' }
      }
    }
  ];
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
