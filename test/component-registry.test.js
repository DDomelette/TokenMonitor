const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dashboardRegistry = require('../renderer/src/grid/components.js');
const settingsRegistry = require('../src/renderer/js/layout/component-registry.js');

function componentSettingDefinitions() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-definitions.js'),
    'utf8'
  );
  const context = {
    window: {
      ComponentRegistry: settingsRegistry
    }
  };
  vm.runInNewContext(source, context, { filename: 'settings-definitions.js' });
  return Array.from(context.window.SettingsDefinitions).filter(
    (definition) => definition.group === '组件'
  );
}

test('component ids and settings keys are unique', () => {
  const items = dashboardRegistry.list();
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert.equal(new Set(items.map((item) => item.settingsKey)).size, items.length);
});

test('every component defines compact and wide presets', () => {
  dashboardRegistry.list().forEach((item) => {
    assert.ok(item.presets.compact.length > 0, item.id);
    assert.ok(item.presets.wide.length > 0, item.id);
    assert.ok(item.defaultPlacement.compact.preset, item.id);
    assert.ok(item.defaultPlacement.wide.preset, item.id);
  });
});

test('fee overview cards are independently registered widgets', () => {
  assert.equal(dashboardRegistry.get('fee-cards'), null);

  ['balance-card', 'today-cost-card', 'cache-rate-card'].forEach((id) => {
    const card = dashboardRegistry.get(id);
    assert.ok(card, id);
    assert.match(card.settingsKey, /^components\./);
    assert.notEqual(card.resizable, false, id);
    ['compact', 'wide'].forEach((breakpoint) => {
      assert.ok(
        card.presets[breakpoint].some((preset) => preset.name === 'card' && preset.w === 4 && preset.h === 4),
        `${breakpoint} ${id} card preset`
      );
      assert.ok(card.presets[breakpoint].length >= 2, `${breakpoint} ${id} resizable presets`);
      assert.ok(
        card.presets[breakpoint].every((preset) => preset.w >= 4 && preset.h >= 4),
        `${breakpoint} ${id} minimum square size`
      );
    });
    assert.equal(card.aspectRatio, 1, `${id} keeps a square visual surface`);
    assert.equal(card.defaultPlacement.compact.preset, 'card');
    assert.equal(card.defaultPlacement.wide.preset, 'card');
  });
});

test('chart presets include a card-sized minimum plus readable larger sizes', () => {
  ['model-bar', 'token-speed', 'token-line', 'cost-line'].forEach((id) => {
    const component = dashboardRegistry.get(id);
    ['compact', 'wide'].forEach((breakpoint) => {
      const presets = component.presets[breakpoint];
      assert.ok(
        presets.some((preset) => preset.name === 'card' && preset.w === 4 && preset.h === 4),
        `${breakpoint} ${id} card preset`
      );
      presets.filter((preset) => preset.name !== 'card').forEach((preset) => {
        assert.ok(preset.h >= 6, `${breakpoint} ${id} ${preset.name}`);
      });
    });
  });
});

test('unknown components are rejected', () => {
  assert.equal(dashboardRegistry.get('missing-component'), null);
});

test('settings and dashboard registries expose the exact same component metadata', () => {
  assert.deepEqual(settingsRegistry.list(), dashboardRegistry.list());
});

test('every dashboard component automatically has one settings toggle', () => {
  const components = dashboardRegistry.list();
  const definitions = componentSettingDefinitions();

  assert.deepEqual(
    definitions.map((definition) => definition.key),
    components.map((component) => component.settingsKey)
  );
  assert.deepEqual(
    definitions.map((definition) => definition.label),
    components.map((component) => component.settingsLabel || component.label)
  );
  assert.equal(new Set(definitions.map((definition) => definition.key)).size, components.length);
});

test('Codex quota, Kimi quota, and Token activity are configurable settings', () => {
  const definitionsByKey = new Map(
    componentSettingDefinitions().map((definition) => [definition.key, definition])
  );

  [
    ['components.quotaCodex', 'Codex 额度'],
    ['components.quotaKimi', 'Kimi 额度'],
    ['components.tokenHeatmap', 'Token 活动']
  ].forEach(([key, label]) => {
    const definition = definitionsByKey.get(key);
    assert.ok(definition, key);
    assert.equal(definition.type, 'toggle');
    assert.equal(definition.label, label);
    assert.equal(definition.default, true);
  });
});

test('React registry imports the canonical browser registry instead of defining another array', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/grid/components.js'),
    'utf8'
  );

  assert.match(source, /src\/renderer\/js\/layout\/component-registry\.js/);
  assert.doesNotMatch(source, /const\s+components\s*=\s*\[/);
  assert.match(source, /globalThis\.ComponentRegistry/);
});
