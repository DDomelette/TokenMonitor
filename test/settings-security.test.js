const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const { sanitizeSettings, isWritableSettingKey, resolveWritableSettingKey } = require('../src/main/core/settings-security');
const ipcJs = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');

test('sanitizeSettings strips credentials but keeps proxy config and other settings', () => {
  const raw = {
    providers: { deepseek: { apiKey: 'sk-secret', sessionToken: 'tok-secret' }, proxyUrl: 'http://127.0.0.1:7890' },
    window: { opacity: 92 }
  };
  const clean = sanitizeSettings(raw);
  assert.equal(clean.providers.deepseek.apiKey, undefined);
  assert.equal(clean.providers.deepseek.sessionToken, undefined);
  assert.equal(clean.providers.proxyUrl, 'http://127.0.0.1:7890');
  assert.equal(clean.window.opacity, 92);
  // 不得修改原对象
  assert.equal(raw.providers.deepseek.apiKey, 'sk-secret');
});

test('every settings payload sent to renderers is sanitized', () => {
  assert.match(ipcJs, /handle\('get:settings'[\s\S]*?sanitizeSettings/);
  assert.doesNotMatch(ipcJs, /send\('settings:loaded',\s*deps\.store\.store\)/);
  assert.doesNotMatch(mainJs, /send\('settings:loaded',\s*store\.store\)/);
  assert.doesNotMatch(mainJs, /broadcastToWindows\('settings:loaded',\s*store\.store\)/);
});

test('isWritableSettingKey allows UI settings and blocks credentials and internal keys', () => {
  // 'apiKey' 是设置界面的遗留顶层键,作为别名允许(写入时映射到 providers.deepseek.apiKey)
  ['window.opacity', 'window.darkMode', 'components.balanceCard', 'data.historyDays', 'layout', 'componentOrder', 'providers.proxyUrl', 'apiKey']
    .forEach((k) => assert.ok(isWritableSettingKey(k), k + ' should be writable'));
  // 规范凭证路径仍不允许直接写,防止渲染进程随意覆写凭证命名空间
  ['providers.deepseek.apiKey', 'providers.deepseek.sessionToken', 'sessionToken', 'usageDaily', '__proto__', 'a__proto__b', '']
    .forEach((k) => assert.ok(!isWritableSettingKey(k), k + ' must be blocked'));
});

test('resolveWritableSettingKey maps the legacy apiKey alias to the canonical path', () => {
  assert.equal(resolveWritableSettingKey('apiKey'), 'providers.deepseek.apiKey');
  assert.equal(resolveWritableSettingKey('window.opacity'), 'window.opacity');
});

test('settings:update handler writes through the resolved canonical key', () => {
  const handler = ipcJs.match(/ipcMain\.on\('settings:update'[\s\S]*?\n  \}\);/);
  assert.ok(handler);
  assert.match(handler[0], /resolveWritableSettingKey/);
});

test('settings:update handler rejects non-whitelisted keys', () => {
  const handler = ipcJs.match(/ipcMain\.on\('settings:update'[\s\S]*?\n  \}\);/);
  assert.ok(handler);
  assert.match(handler[0], /isWritableSettingKey/);
});
