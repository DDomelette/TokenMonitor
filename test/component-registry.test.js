const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../src/renderer/js/layout/component-registry');

const root = path.resolve(__dirname, '..');

test('component ids and settings keys are unique', () => {
  const items = registry.list();
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert.equal(new Set(items.map((item) => item.settingsKey)).size, items.length);
});

test('every component defines compact and wide presets', () => {
  registry.list().forEach((item) => {
    assert.ok(item.presets.compact.length > 0, item.id);
    assert.ok(item.presets.wide.length > 0, item.id);
    assert.ok(item.defaultPlacement.compact.preset, item.id);
    assert.ok(item.defaultPlacement.wide.preset, item.id);
  });
});

test('fee overview cards are independently registered widgets', () => {
  assert.equal(registry.get('fee-cards'), null);

  ['balance-card', 'today-cost-card', 'cache-rate-card'].forEach((id) => {
    const card = registry.get(id);
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
  ['model-bar', 'token-line', 'cost-line'].forEach((id) => {
    const component = registry.get(id);
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
  assert.equal(registry.get('missing-component'), null);
});

test('renderer windows load registry-driven settings definitions', () => {
  ['index.html', 'settings-window.html'].forEach((name) => {
    const html = fs.readFileSync(path.join(root, 'src/renderer', name), 'utf8');
    const registryIndex = html.indexOf('js/layout/component-registry.js');
    const settingsIndex = html.indexOf('js/settings-definitions.js');
    assert.ok(registryIndex >= 0, name + ' registry script');
    assert.ok(settingsIndex > registryIndex, name + ' script order');
  });

  const definitions = fs.readFileSync(
    path.join(root, 'src/renderer/js/settings-definitions.js'),
    'utf8'
  );
  assert.match(definitions, /ComponentRegistry\.list\(\)/);
  assert.doesNotMatch(definitions, /components\.feeCards/);
});
