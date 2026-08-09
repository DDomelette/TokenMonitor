const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { saveSetting } = require('../src/main/core/settings-write');
const { startScheduler } = require('../src/main/core/scheduler');
const { fetchBalance } = require('../src/main/providers/deepseek/balance');

function source(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

test('new installations default to direct rather than localhost port 7890', () => {
  const storeSource = source('src/main/store.js');

  assert.match(storeSource, /proxyUrl:\s*''/);
  assert.doesNotMatch(storeSource, /proxyUrl:\s*'http:\/\/127\.0\.0\.1:7890'/);
});

test('invalid proxy settings are rejected before persistence, side effects, or broadcast', () => {
  const writes = [];
  const applied = [];
  let broadcasts = 0;
  const deps = {
    store: { set: (key, value) => writes.push({ key, value }) },
    applySetting: (key, value) => applied.push({ key, value }),
    broadcastSettings: () => { broadcasts += 1; }
  };

  assert.throws(
    () => saveSetting(deps, {
      key: 'providers.proxyUrl',
      value: 'https://user:secret@proxy.example:443/path?token=secret'
    }),
    (error) => error && error.code === 'INVALID_PROXY_SETTING'
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(applied, []);
  assert.equal(broadcasts, 0);

  assert.deepEqual(
    saveSetting(deps, {
      key: 'providers.proxyUrl',
      value: 'http://Proxy.Example:8080'
    }),
    { ok: true }
  );
  assert.deepEqual(writes, [{
    key: 'providers.proxyUrl',
    value: 'http://proxy.example:8080'
  }, {
    // 自定义代理保存成功时顺手记下"上次使用的地址",供设置页预填
    key: 'providers.proxyUrlLastCustom',
    value: 'http://proxy.example:8080'
  }]);
  assert.equal(broadcasts, 1);
});

test('scheduler ProviderContext consumes the injected live proxy input getter', async () => {
  const resolver = async () => 'http://system.example:3128';
  let capturedProxyInput = null;
  const provider = {
    id: 'fake',
    displayName: 'Fake',
    capabilities: {
      balance: false,
      webUsage: false,
      quota: true,
      localLog: false,
      realtimeProxy: true
    },
    authStatus() { return 'ok'; },
    async fetchQuota(ctx) {
      capturedProxyInput = ctx.getProxyUrl();
      return { provider: 'fake', windows: [] };
    }
  };
  const scheduler = startScheduler({
    registry: {
      list: () => [provider],
      get: (id) => (id === provider.id ? provider : undefined)
    },
    store: { get: () => '' },
    getProxyInput: () => resolver,
    broadcast: () => {},
    intervals: false
  });

  try {
    await scheduler.poll('fake', 'quota');
    assert.equal(capturedProxyInput, resolver);
  } finally {
    scheduler.stop();
  }
});

test('stored system mode reaches both scheduler polling and API-key verification as a resolver', async () => {
  let schedulerProxyInput = null;
  const provider = {
    id: 'fake',
    displayName: 'Fake',
    capabilities: {
      balance: false,
      webUsage: false,
      quota: true,
      localLog: false,
      realtimeProxy: true
    },
    authStatus() { return 'ok'; },
    async fetchQuota(ctx) {
      schedulerProxyInput = ctx.getProxyUrl();
      return { provider: 'fake', windows: [] };
    }
  };
  const scheduler = startScheduler({
    registry: {
      list: () => [provider],
      get: (id) => (id === provider.id ? provider : undefined)
    },
    store: { get: () => 'system' },
    broadcast: () => {},
    intervals: false
  });

  try {
    await scheduler.poll('fake', 'quota');
    assert.equal(typeof schedulerProxyInput, 'function');
  } finally {
    scheduler.stop();
  }

  let verificationProxyInput = null;
  const result = await fetchBalance('api-key', {
    proxyUrl: 'system',
    httpGet: async function (url, headers, proxyInput) {
      verificationProxyInput = proxyInput;
      return {
        is_available: true,
        balance_infos: [{
          currency: 'CNY',
          total_balance: '1',
          granted_balance: '0',
          topped_up_balance: '1'
        }]
      };
    }
  });
  assert.equal(result.total, '1');
  assert.equal(typeof verificationProxyInput, 'function');
});

test('main-process network boundaries centralize Electron system proxy resolution', () => {
  const policySource = source('src/main/core/proxy-settings.js');
  const schedulerSource = source('src/main/core/scheduler.js');
  const balanceSource = source('src/main/providers/deepseek/balance.js');

  assert.match(policySource, /session\.defaultSession/);
  assert.match(policySource, /defaultSession\.resolveProxy\(targetUrl\)/);
  assert.match(schedulerSource, /stored === SYSTEM_PROXY_VALUE \? resolveElectronSystemProxy : stored/);
  assert.match(balanceSource, /value === SYSTEM_PROXY_VALUE/);
  assert.match(balanceSource, /return resolveElectronSystemProxy/);
});

test('settings page exposes direct, system, and custom proxy controls with explicit apply feedback', () => {
  const definitions = source('src/renderer/js/settings-definitions.js');
  const windowSource = source('src/renderer/js/settings-window.js');

  assert.match(definitions, /group:\s*'网络'/);
  assert.match(definitions, /key:\s*'providers\.proxyUrl'/);
  assert.match(definitions, /type:\s*'proxy'/);

  assert.match(windowSource, /proxyModeSelect/);
  assert.match(windowSource, /value="direct"/);
  assert.match(windowSource, /value="system"/);
  assert.match(windowSource, /value="custom"/);
  assert.match(windowSource, /proxyUrlInput/);
  assert.match(windowSource, /proxySaveBtn/);
  assert.match(windowSource, /proxyFeedback/);
  assert.match(windowSource, /window\.api\.invoke\('settings:save'/);
  assert.match(windowSource, /key:\s*'providers\.proxyUrl'/);
  assert.doesNotMatch(windowSource, /data-key="providers\.proxyUrl"/);
});
