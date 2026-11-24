const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../src/renderer/js/layout/component-registry.js');

test('full chart presets leave enough vertical room for legends and two value axes', () => {
  for (const id of ['model-bar', 'provider-bar', 'token-line', 'cost-line', 'token-speed']) {
    const component = registry.get(id);
    for (const breakpoint of ['compact', 'wide']) {
      const usefulPresets = component.presets[breakpoint].filter((preset) => preset.name !== 'card');
      assert(usefulPresets.every((preset) => preset.h >= 8), id + ' has an overly short chart preset');
      const placement = component.defaultPlacement[breakpoint];
      assert.equal(placement.h, registry.get(id).presets[breakpoint].find((preset) => preset.name === placement.preset).h);
    }
  }
});

test('cumulative axis uses the same density and overlap protection as the daily axis', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/src/components/ChartWidget.jsx'), 'utf8');
  assert.match(source, /splitNumber: density\.yAxis\.splitNumber/);
  assert.match(source, /formatter: axisFormatter, hideOverlap: true/);
  assert.match(source, /formatter: dailyAxisFormatter/);
  assert.match(source, /maximumFractionDigits: Math\.abs\(Number\(value\)\) < 10 \? 2 : 0/);
});
