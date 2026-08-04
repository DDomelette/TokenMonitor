const { contextBridge } = require('electron');

const listeners = new Map();
let settings = {
  components: {
    quotaCodex: false,
    quotaKimi: false,
    balanceCard: false,
    todayCostCard: false,
    cacheRateCard: false,
    modelBar: false,
    providerBar: false,
    tokenLine: true,
    costLine: true,
    tokenHeatmap: false
  },
  layout: null,
  componentOrder: ['token-line', 'cost-line'],
  window: { layoutLocked: true }
};

function emit(channel, payload) {
  const callbacks = listeners.get(channel);
  if (!callbacks) return;
  callbacks.forEach((callback) => callback(payload));
}

contextBridge.exposeInMainWorld('api', {
  invoke(channel) {
    if (channel === 'get:settings') return Promise.resolve(settings);
    if (channel === 'get:providers') return Promise.resolve([]);
    if (channel === 'get:dashboard') {
      return Promise.resolve({
        providerId: 'deepseek',
        balance: null,
        stats: { cost: null, token: null, costDaily: [], tokenDaily: [] },
        curveToken: [],
        curveCost: [],
        proxyStatus: { running: false, port: 0, error: null }
      });
    }
    if (channel === 'get:heatmap') {
      return Promise.resolve({
        days: [],
        max: 0,
        details: { byProvider: {}, cachedByProvider: {}, deepseekModels: {} }
      });
    }
    if (channel === 'get:bounds') {
      return Promise.resolve({ x: 0, y: 0, width: 760, height: 900 });
    }
    return Promise.resolve(null);
  },
  send() {},
  on(channel, callback) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(callback);
    return () => {
      const callbacks = listeners.get(channel);
      if (callbacks) callbacks.delete(callback);
    };
  },
  __emitSettings(nextSettings) {
    settings = nextSettings;
    emit('settings:loaded', settings);
  }
});
