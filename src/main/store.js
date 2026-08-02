const Store = require('electron-store');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function getEncryptionKey() {
  const keyPath = path.join(app.getPath('userData'), '.key');
  try {
    const raw = fs.readFileSync(keyPath, 'utf-8').trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return raw;
    throw new Error('invalid key');
  } catch (e) {
    const dir = path.dirname(keyPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    return key;
  }
}

const defaults = {
  providers: {
    deepseek: {
      apiKey: '',
      sessionToken: ''
    },
    proxyUrl: 'http://127.0.0.1:7890'
  },
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
    balanceCard: true,
    todayCostCard: true,
    cacheRateCard: true,
    modelBar: true,
    tokenLine: true,
    costLine: true
  },
  layout: null,
  componentOrder: ['balance-card', 'today-cost-card', 'cache-rate-card', 'model-bar', 'token-line', 'cost-line'],
  data: {
    sampleInterval: 30,
    defaultTimeRange: '1h',
    proxyPort: 7890,
    historyDays: 7
  }
};

const store = new Store({
  defaults,
  encryptionKey: getEncryptionKey(),
  clearInvalidConfig: true
});

// 旧键 → provider 命名空间键的一次性迁移。storeLike 可为真实 electron-store 或纯对象(fake store 便于单测)。
// 旧值保留校验:仅在新键缺失时复制旧值,随后删除旧键。
function migrateLegacyKeys(storeLike) {
  let migrated = false;
  const oldSession = storeLike.get('sessionToken');
  if (oldSession && !storeLike.get('providers.deepseek.sessionToken')) {
    storeLike.set('providers.deepseek.sessionToken', oldSession);
    migrated = true;
  }
  const oldApiKey = storeLike.get('apiKey');
  if (oldApiKey && !storeLike.get('providers.deepseek.apiKey')) {
    storeLike.set('providers.deepseek.apiKey', oldApiKey);
    migrated = true;
  }
  if (storeLike.get('providers.deepseek.sessionToken')) storeLike.delete('sessionToken');
  if (storeLike.get('providers.deepseek.apiKey')) storeLike.delete('apiKey');
  return migrated;
}

module.exports = store;
module.exports.migrateLegacyKeys = migrateLegacyKeys;
// 安全边界函数实现于 core/settings-security.js(无 electron 依赖,便于单测),此处透传
Object.assign(module.exports, require('./core/settings-security'));
