const { initializeStore } = require('./core/store-recovery');
const { normalizeHistoryDays } = require('./core/usage-retention');
const settingsSecurity = require('./core/settings-security');

const defaults = {
  providers: {
    deepseek: {
      apiKey: '',
      sessionToken: ''
    },
    proxyUrl: '',
    proxyUrlLastCustom: ''
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
    layoutLocked: true,
    // 贴边自动隐藏(issue #170):edgeDock 只存逻辑停靠信息(边 + 展开可见 bounds),
    // 隐藏坐标永不落盘
    edgeAutoHide: false,
    edgeDock: null,
    // 迷你模式:只显示额度圆环/余额 + Token 速度的小窗状态;
    // miniBounds 单独记忆迷你窗口的位置尺寸,正常 bounds 不被覆盖
    miniMode: false,
    miniBounds: null
  },
  components: {
    balanceCard: true,
    todayCostCard: true,
    cacheRateCard: true,
    modelBar: true,
    providerBar: true,
    tokenSpeed: false,
    tokenLine: true,
    costLine: true
  },
  layout: null,
  componentOrder: [
    'balance-card',
    'today-cost-card',
    'cache-rate-card',
    'model-bar',
    'provider-bar',
    'token-speed',
    'token-line',
    'cost-line'
  ],
  data: {
    sampleInterval: 30,
    defaultTimeRange: '1h',
    historyDays: 7,
    tokenSpeed: {
      intervalSeconds: 30,
      providerFilter: 'all'
    }
  }
};

let storeInstance = null;

function createStore(options = {}) {
  const StoreClass = options.StoreClass || require('electron-store');
  return initializeStore({
    StoreClass,
    userDataDir: options.userDataDir,
    defaults: options.defaults || defaults,
    fsImpl: options.fsImpl,
    cryptoImpl: options.cryptoImpl,
    now: options.now
  });
}

function initialize(options = {}) {
  if (storeInstance) return storeInstance;
  storeInstance = createStore(options);
  return storeInstance;
}

function requireStoreInstance() {
  if (storeInstance) return storeInstance;
  const error = new Error('Store has not been initialized.');
  error.code = 'STORE_NOT_INITIALIZED';
  throw error;
}

// 旧键 → provider 命名空间键的一次性迁移。storeLike 可为真实 electron-store 或纯对象。
// 顺带修复历史版本遗留的类型错误:自定义下拉框曾把 data.historyDays 存成字符串。
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
  const historyDays = normalizeHistoryDays(storeLike.get('data.historyDays'));
  if (historyDays !== null && storeLike.get('data.historyDays') !== historyDays) {
    storeLike.set('data.historyDays', historyDays);
    migrated = true;
  }
  return migrated;
}

const facade = {
  createStore,
  defaults,
  initialize,
  migrateLegacyKeys,
  ...settingsSecurity
};

module.exports = new Proxy(facade, {
  get(target, property, receiver) {
    if (Object.prototype.hasOwnProperty.call(target, property)) {
      return Reflect.get(target, property, receiver);
    }
    const instance = requireStoreInstance();
    const value = Reflect.get(instance, property, instance);
    return typeof value === 'function' ? value.bind(instance) : value;
  },
  set(target, property, value, receiver) {
    if (Object.prototype.hasOwnProperty.call(target, property)) {
      return Reflect.set(target, property, value, receiver);
    }
    const instance = requireStoreInstance();
    return Reflect.set(instance, property, value, instance);
  },
  has(target, property) {
    return Object.prototype.hasOwnProperty.call(target, property)
      || (storeInstance ? Reflect.has(storeInstance, property) : false);
  }
});
