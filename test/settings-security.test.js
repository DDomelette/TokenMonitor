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
  ['window.opacity', 'window.darkMode', 'components.balanceCard', 'data.historyDays', 'layout', 'componentOrder', 'providers.proxyUrl']
    .forEach((k) => assert.ok(isWritableSettingKey(k), k + ' should be writable'));
  ['apiKey', 'providers.deepseek.apiKey', 'providers.deepseek.sessionToken', 'sessionToken', 'usageDaily', '__proto__', 'a__proto__b', '']
    .forEach((k) => assert.ok(!isWritableSettingKey(k), k + ' must be blocked'));
});

test('resolveWritableSettingKey leaves removed credential aliases unresolved', () => {
  assert.equal(resolveWritableSettingKey('apiKey'), 'apiKey');
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

test('mcp.enabled is writable but mcp.token stays a protected credential', () => {
  assert.equal(isWritableSettingKey('mcp.enabled'), true);
  assert.equal(isWritableSettingKey('mcp.token'), false);
});

test('sanitizeSettings strips mcp.token from renderer-bound copies', () => {
  const out = sanitizeSettings({ mcp: { enabled: true, token: 'secret-token' } });
  assert.equal(out.mcp.enabled, true);
  assert.equal(out.mcp.token, undefined);
});

test('sanitizeSettings strips usageDaily and usageDailyCost from renderer-bound copies', () => {
  const raw = {
    usageDaily: {
      'dsh:2026-08-14': { input: 1, cached: 0, output: 1, total: 2 },
      'kimi:2026-08-14': { input: 0, cached: 0, output: 5, total: 5 }
    },
    usageDailyCost: { 'dsh:2026-08-14': 0.001 },
    window: { opacity: 92 }
  };
  const clean = sanitizeSettings(raw);
  // 用量/费用聚合属于大数据键,走专用 IPC(get:heatmap/get:dashboard),不进 settings 载荷。
  assert.equal(clean.usageDaily, undefined);
  assert.equal(clean.usageDailyCost, undefined);
  // 其余设置不受影响,原对象不被修改
  assert.equal(clean.window.opacity, 92);
  assert.ok(raw.usageDaily['dsh:2026-08-14']);
  assert.ok(raw.usageDailyCost['dsh:2026-08-14']);
});

test('collectionMode is writable but ingest token remains protected', () => {
  assert.equal(isWritableSettingKey('providers.dsh.collectionMode'), true);
  assert.equal(isWritableSettingKey('ingest.dsh.token'), false);
});

test('sanitizeSettings strips push ledger, registry, sources and ingest token', () => {
  const raw = {
    usageDailyPush: { 'dsh:2026-08-14': { input: 1, cached: 0, output: 1, total: 2 } },
    usageDailyCostPush: { 'dsh:2026-08-14': 0.001 },
    ingest: {
      dsh: {
        enabled: true,
        token: 'secret-ingest-token',
        batchRegistry: { src: { b: { acceptedAt: 1 } } },
        sources: { src: { lastIngestAt: 1 } },
        diagnostics: { 'invalid-row': 1 }
      }
    },
    window: { opacity: 92 }
  };
  const clean = sanitizeSettings(raw);
  assert.equal(clean.usageDailyPush, undefined);
  assert.equal(clean.usageDailyCostPush, undefined);
  assert.equal(clean.ingest.dsh.enabled, true);
  assert.equal(clean.ingest.dsh.token, undefined);
  assert.equal(clean.ingest.dsh.batchRegistry, undefined);
  assert.equal(clean.ingest.dsh.sources, undefined);
  assert.equal(clean.ingest.dsh.diagnostics, undefined);
});
