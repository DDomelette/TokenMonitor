(function (root, factory) {
  var api = factory();
  root.ComponentRegistry = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var components = [
    {
      id: 'quota-codex',
      label: 'Codex 额度',
      settingsKey: 'components.quotaCodex',
      defaultVisible: true,
      presets: {
        compact: [
          { name: 'full', w: 12, h: 7 },
          { name: 'half', w: 6, h: 7 },
          { name: 'tall', w: 12, h: 9 }
        ],
        wide: [
          { name: 'full', w: 12, h: 7 },
          { name: 'half', w: 6, h: 7 },
          { name: 'tall', w: 12, h: 9 }
        ]
      },
      defaultPlacement: {
        compact: { x: 0, y: 0, w: 12, h: 7, preset: 'full' },
        wide: { x: 0, y: 0, w: 12, h: 7, preset: 'full' }
      }
    },
    {
      id: 'quota-kimi',
      label: 'Kimi 额度',
      settingsKey: 'components.quotaKimi',
      defaultVisible: true,
      presets: {
        compact: [
          { name: 'full', w: 12, h: 7 },
          { name: 'half', w: 6, h: 7 },
          { name: 'tall', w: 12, h: 9 }
        ],
        wide: [
          { name: 'full', w: 12, h: 7 },
          { name: 'half', w: 6, h: 7 },
          { name: 'tall', w: 12, h: 9 }
        ]
      },
      defaultPlacement: {
        compact: { x: 0, y: 7, w: 12, h: 7, preset: 'full' },
        wide: { x: 0, y: 7, w: 12, h: 7, preset: 'full' }
      }
    },
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
        compact: { x: 0, y: 14, w: 4, h: 4, preset: 'card' },
        wide: { x: 0, y: 14, w: 4, h: 4, preset: 'card' }
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
        compact: { x: 4, y: 14, w: 4, h: 4, preset: 'card' },
        wide: { x: 4, y: 14, w: 4, h: 4, preset: 'card' }
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
        compact: { x: 8, y: 14, w: 4, h: 4, preset: 'card' },
        wide: { x: 8, y: 14, w: 4, h: 4, preset: 'card' }
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
        compact: { x: 0, y: 18, w: 12, h: 6, preset: 'full' },
        wide: { x: 0, y: 18, w: 12, h: 6, preset: 'full' }
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
        compact: { x: 0, y: 24, w: 12, h: 6, preset: 'full' },
        wide: { x: 0, y: 24, w: 12, h: 6, preset: 'full' }
      }
    },
    {
      id: 'token-speed',
      label: 'Token 消耗速度',
      settingsLabel: 'Token 消耗速度（会增加内存占用）',
      settingsKey: 'components.tokenSpeed',
      defaultVisible: false,
      presets: {
        compact: [
          { name: 'card', w: 4, h: 4 },
          { name: 'half', w: 6, h: 6 },
          { name: 'full', w: 12, h: 7 },
          { name: 'tall', w: 12, h: 9 }
        ],
        wide: [
          { name: 'card', w: 4, h: 4 },
          { name: 'half', w: 6, h: 6 },
          { name: 'full', w: 12, h: 7 },
          { name: 'tall', w: 12, h: 9 }
        ]
      },
      defaultPlacement: {
        compact: { x: 0, y: 30, w: 12, h: 7, preset: 'full' },
        wide: { x: 0, y: 30, w: 12, h: 7, preset: 'full' }
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
        compact: { x: 0, y: 37, w: 12, h: 6, preset: 'full' },
        wide: { x: 0, y: 37, w: 12, h: 6, preset: 'full' }
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
        compact: { x: 0, y: 43, w: 12, h: 6, preset: 'full' },
        wide: { x: 0, y: 43, w: 12, h: 6, preset: 'full' }
      }
    },
    {
      id: 'token-heatmap',
      label: 'Token 活动',
      settingsKey: 'components.tokenHeatmap',
      defaultVisible: true,
      presets: {
        compact: [
          { name: 'full', w: 12, h: 10 },
          { name: 'half', w: 6, h: 11 },
          { name: 'tall', w: 12, h: 12 }
        ],
        wide: [
          { name: 'full', w: 12, h: 10 },
          { name: 'half', w: 6, h: 11 },
          { name: 'tall', w: 12, h: 12 }
        ]
      },
      defaultPlacement: {
        compact: { x: 0, y: 49, w: 12, h: 10, preset: 'full' },
        wide: { x: 0, y: 49, w: 12, h: 10, preset: 'full' }
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
