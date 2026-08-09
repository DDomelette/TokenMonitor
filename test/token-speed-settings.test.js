const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const registry = require('../src/renderer/js/layout/component-registry.js');

test('token speed settings accept only the eight windows and four filters', () => {
  const settings = require('../src/main/core/token-speed-settings');
  assert.deepEqual(settings.INTERVAL_SECONDS, [10, 20, 30, 60, 180, 300, 3600, 18000]);
  assert.deepEqual(settings.PROVIDER_FILTERS, ['all', 'deepseek', 'codex', 'kimi']);
  assert.equal(settings.normalizeIntervalSeconds('180'), 180);
  assert.equal(settings.normalizeIntervalSeconds(11), 30);
  assert.equal(settings.normalizeProviderFilter('kimi'), 'kimi');
  assert.equal(settings.normalizeProviderFilter('unknown'), 'all');
  assert.deepEqual(settings.normalizeTokenSpeedSettings({
    intervalSeconds: '300', providerFilter: 'codex'
  }), { intervalSeconds: 300, providerFilter: 'codex' });
});

test('token speed is registered as a default-hidden chart with a warning label', () => {
  const component = registry.get('token-speed');
  assert.ok(component);
  assert.equal(component.settingsKey, 'components.tokenSpeed');
  assert.equal(component.defaultVisible, false);
  assert.equal(component.settingsLabel, 'Token 消耗速度（会增加内存占用）');
  assert.equal(component.defaultPlacement.compact.preset, 'full');
  assert.ok(component.presets.compact.some((preset) => preset.name === 'card'));
});

test('settings definitions expose token speed selectors only when enabled', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-definitions.js'), 'utf8'
  );
  const context = { window: { ComponentRegistry: registry } };
  vm.runInNewContext(source, context, { filename: 'settings-definitions.js' });
  const definitions = Array.from(context.window.SettingsDefinitions);
  const toggle = definitions.find((item) => item.key === 'components.tokenSpeed');
  const interval = definitions.find((item) => item.key === 'data.tokenSpeed.intervalSeconds');
  const filter = definitions.find((item) => item.key === 'data.tokenSpeed.providerFilter');
  assert.equal(toggle.label, 'Token 消耗速度（会增加内存占用）');
  assert.deepEqual(Array.from(interval.options, (item) => Number(item.value)), [10, 20, 30, 60, 180, 300, 3600, 18000]);
  assert.equal(interval.visibleWhen.key, 'components.tokenSpeed');
  assert.deepEqual(Array.from(filter.options, (item) => item.value), ['all', 'deepseek', 'codex', 'kimi']);
  assert.equal(filter.visibleWhen.key, 'components.tokenSpeed');
});

test('settings window filters conditional definitions from the live settings snapshot', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-window.js'), 'utf8'
  );
  assert.match(source, /visibleWhen/);
  assert.match(source, /getNested\(settings, d\.visibleWhen\.key\)/);
});
