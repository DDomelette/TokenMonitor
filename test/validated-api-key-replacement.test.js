const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loadReplacement() {
  return require('../src/main/core/api-key-replacement');
}

test('valid replacement does not touch the saved key until verification succeeds', async () => {
  const { replaceDeepseekApiKey } = loadReplacement();
  const verification = deferred();
  const calls = [];
  const store = {
    value: 'sk-old-valid',
    get(key) {
      assert.equal(key, 'providers.deepseek.apiKey');
      return this.value;
    },
    set(key, value) {
      calls.push(['set', key, value]);
      this.value = value;
    }
  };

  const replacing = replaceDeepseekApiKey({
    store,
    verifyApiKey(candidate) {
      calls.push(['verify', candidate]);
      return verification.promise;
    },
    broadcastSettings() {
      calls.push(['broadcast']);
    }
  }, { apiKey: '  sk-new-valid  ' });

  await Promise.resolve();
  assert.equal(store.value, 'sk-old-valid');
  assert.deepEqual(calls, [['verify', 'sk-new-valid']]);

  verification.resolve({ available: true, total: '10.00' });
  assert.deepEqual(await replacing, { ok: true });
  assert.equal(store.value, 'sk-new-valid');
  assert.deepEqual(calls, [
    ['verify', 'sk-new-valid'],
    ['set', 'providers.deepseek.apiKey', 'sk-new-valid'],
    ['broadcast']
  ]);
});

test('invalid replacement preserves the old key and does not broadcast', async () => {
  const { replaceDeepseekApiKey } = loadReplacement();
  const calls = [];
  const store = {
    value: 'sk-old-valid',
    set(key, value) {
      calls.push(['set', key, value]);
      this.value = value;
    }
  };

  await assert.rejects(
    replaceDeepseekApiKey({
      store,
      verifyApiKey(candidate) {
        calls.push(['verify', candidate]);
        return Promise.reject(new Error('Unauthorized'));
      },
      broadcastSettings() {
        calls.push(['broadcast']);
      }
    }, { apiKey: 'sk-invalid' }),
    /Unauthorized/
  );

  assert.equal(store.value, 'sk-old-valid');
  assert.deepEqual(calls, [['verify', 'sk-invalid']]);
});

test('empty replacement is rejected before verification and cannot clear the key', async () => {
  const { replaceDeepseekApiKey } = loadReplacement();
  const calls = [];
  const store = {
    value: 'sk-old-valid',
    set() {
      calls.push('set');
      this.value = '';
    }
  };

  await assert.rejects(
    replaceDeepseekApiKey({
      store,
      verifyApiKey() {
        calls.push('verify');
      },
      broadcastSettings() {
        calls.push('broadcast');
      }
    }, { apiKey: '   ' }),
    /API key is required/i
  );

  assert.equal(store.value, 'sk-old-valid');
  assert.deepEqual(calls, []);
});

test('generic settings writes reject API key aliases and canonical credential paths', () => {
  const {
    isWritableSettingKey,
    resolveWritableSettingKey
  } = require('../src/main/core/settings-security');

  assert.equal(isWritableSettingKey('apiKey'), false);
  assert.equal(isWritableSettingKey('providers.deepseek.apiKey'), false);
  assert.equal(resolveWritableSettingKey('apiKey'), 'apiKey');
  assert.equal(isWritableSettingKey('window.darkMode'), true);
});

test('preload and main process expose a dedicated validated API key replacement channel', () => {
  const preload = fs.readFileSync(
    path.resolve(__dirname, '../src/preload/preload.js'),
    'utf8'
  );
  const ipc = fs.readFileSync(
    path.resolve(__dirname, '../src/main/ipc.js'),
    'utf8'
  );

  assert.match(preload, /invoke:[\s\S]*?'settings:replace-api-key'/);
  assert.match(ipc, /const \{ replaceDeepseekApiKey \} = require\('\.\/core\/api-key-replacement'\);/);
  assert.match(
    ipc,
    /ipcMain\.handle\('settings:replace-api-key', async \(event, payload\) => \{[\s\S]*?return replaceDeepseekApiKey\(\{[\s\S]*?store:\s*deps\.store,[\s\S]*?verifyApiKey:\s*\(apiKey\) => deepseek\.fetchBalance\(deepseekApiKeyCtx\(deps, apiKey\)\),[\s\S]*?broadcastSettings:\s*deps\.broadcastSettings[\s\S]*?\}, payload\);[\s\S]*?\}\);/
  );
});

test('settings page uses an explicit credential submit control and never queues typed API key input', () => {
  const definitions = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-definitions.js'),
    'utf8'
  );
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-window.js'),
    'utf8'
  );

  assert.match(definitions, /key: 'apiKey', type: 'credential'/);
  assert.match(source, /id="deepseekApiKeyInput"/);
  assert.match(source, /id="deepseekApiKeySaveBtn"/);
  assert.doesNotMatch(source, /id="deepseekApiKeyInput"[^>]*data-key=/);
  assert.match(
    source,
    /function submitDeepseekApiKey\(\)[\s\S]*?window\.api\.invoke\('settings:replace-api-key', \{ apiKey: candidate \}\)/
  );
  assert.match(
    source,
    /deepseekApiKeySaveBtn[\s\S]*?addEventListener\('click', submitDeepseekApiKey\)/
  );
  assert.match(source, /API Key 验证失败，已保留原值。/);
});

test('typing or abandoning the credential input does not enter the generic close-time settings queue', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-window.js'),
    'utf8'
  );

  assert.match(source, /document\.querySelectorAll\('input\[data-key\]'\)/);
  assert.doesNotMatch(source, /settingsUpdateQueue\.schedule\('apiKey'/);
  assert.doesNotMatch(source, /handleChange\(document\.getElementById\('deepseekApiKeyInput'\)\)/);
});

test('generic acknowledged writer tests use a non-credential setting', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, './settings-close-durability.test.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /saveSetting\([\s\S]*?\{ key: 'apiKey'/);
  assert.match(source, /saveSetting\([\s\S]*?\{ key: 'window\.darkMode', value: 'dark' \}/);
});
