const Store = require('electron-store');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function getEncryptionKey() {
  const keyPath = path.join(app.getPath('userData'), '.key');
  try {
    return fs.readFileSync(keyPath, 'utf-8');
  } catch (e) {
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
  }
}

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
  encryptionKey: getEncryptionKey()
});

module.exports = store;
