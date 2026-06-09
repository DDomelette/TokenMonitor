const Store = require('electron-store');

const defaults = {
  apiKey: '',
  window: {
    x: undefined,
    y: undefined,
    width: 420,
    height: 680,
    opacity: 92,
    alwaysOnTop: true,
    autoLaunch: false,
    followSystemTheme: true,
    layoutLocked: true
  },
  components: {
    feeCards: true,
    modelBar: true,
    tokenLine: true,
    costLine: true
  },
  componentOrder: ['fee-cards', 'model-bar', 'token-line', 'cost-line'],
  data: {
    sampleInterval: 30,
    defaultTimeRange: '1h',
    proxyPort: 7890,
    historyDays: 7
  }
};

const store = new Store({
  defaults,
  encryptionKey: 'token-monitor-local-dev-key'
});

module.exports = store;
