const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../renderer/src/grid/policy.js');

test('639 is compact and 640 is wide', () => {
  assert.equal(policy.breakpointForWidth(639), 'compact');
  assert.equal(policy.breakpointForWidth(640), 'wide');
  assert.equal(policy.columnsForBreakpoint('compact'), 12);
  assert.equal(policy.columnsForBreakpoint('wide'), 12);
});

test('nearest preset returns full for a nearly full model bar', () => {
  assert.equal(policy.nearestPreset('model-bar', 'wide', 11.6, 6).name, 'full');
});

test('chart widgets can snap down to card size while larger presets remain available', () => {
  assert.equal(policy.nearestPreset('model-bar', 'wide', 4, 4).name, 'card');
  assert.equal(policy.nearestPreset('token-line', 'compact', 4, 4).name, 'card');
  assert.equal(policy.nearestPreset('model-bar', 'compact', 6, 6).name, 'half');
  assert.equal(policy.nearestPreset('cost-line', 'compact', 12, 6).name, 'full');
  assert.equal(policy.nearestPreset('cost-line', 'wide', 12, 6).name, 'full');
});

test('default compact layout keeps stat cards as square tiles above full-width charts', () => {
  const compact = policy.defaultLayout('compact');
  const byId = Object.fromEntries(compact.items.map((item) => [item.id, item]));

  assert.equal(compact.columns, 12);
  // 订阅额度卡置顶,统计卡紧随其后,图表与热力图依次排下
  assert.deepEqual(
    ['quota-codex', 'quota-kimi'].map((id) => ({
      x: byId[id].x,
      y: byId[id].y,
      w: byId[id].w
    })),
    [
      { x: 0, y: 0, w: 12 },
      { x: 0, y: 7, w: 12 }
    ]
  );
  assert.deepEqual(
    ['balance-card', 'today-cost-card', 'cache-rate-card'].map((id) => ({
      x: byId[id].x,
      y: byId[id].y,
      w: byId[id].w,
      h: byId[id].h
    })),
    [
      { x: 0, y: 14, w: 4, h: 4 },
      { x: 4, y: 14, w: 4, h: 4 },
      { x: 8, y: 14, w: 4, h: 4 }
    ]
  );
  assert.deepEqual(
    ['model-bar', 'token-line', 'cost-line', 'token-heatmap'].map((id) => ({ x: byId[id].x, w: byId[id].w })),
    [
      { x: 0, w: 12 },
      { x: 0, w: 12 },
      { x: 0, w: 12 },
      { x: 0, w: 12 }
    ]
  );
});

test('migration rebuilds default compact layout with stat cards in a row', () => {
  const migrated = policy.migrate({
    componentOrder: ['balance-card', 'today-cost-card', 'cache-rate-card', 'model-bar', 'token-line', 'cost-line']
  });
  const byId = Object.fromEntries(migrated.compact.items.map((item) => [item.id, item]));

  assert.equal(migrated.version, policy.VERSION);
  assert.equal(migrated.compact.columns, 12);
  // 旧 componentOrder 不含新增板块:quota 卡按注册表顺序插到统计卡之前
  assert.deepEqual(
    ['balance-card', 'today-cost-card', 'cache-rate-card'].map((id) => ({
      x: byId[id].x,
      y: byId[id].y,
      w: byId[id].w,
      h: byId[id].h
    })),
    [
      { x: 0, y: 14, w: 4, h: 4 },
      { x: 4, y: 14, w: 4, h: 4 },
      { x: 8, y: 14, w: 4, h: 4 }
    ]
  );
});

test('resize direction advances to the next chart preset instead of snapping back', () => {
  assert.equal(
    policy.presetAfterResize('model-bar', 'wide', { w: 12, h: 6 }, { w: 11, h: 6 }).name,
    'half'
  );
  assert.equal(
    policy.presetAfterResize('model-bar', 'wide', { w: 6, h: 6 }, { w: 5, h: 5 }).name,
    'card'
  );
});

test('migration preserves compact component order', () => {
  const migrated = policy.migrate({
    componentOrder: ['cost-line', 'balance-card', 'today-cost-card', 'cache-rate-card', 'model-bar', 'token-line']
  });

  assert.deepEqual(
    migrated.compact.items.map((item) => item.id),
    ['quota-codex', 'quota-kimi', 'provider-bar', 'token-speed', 'cost-line', 'balance-card', 'today-cost-card', 'cache-rate-card', 'model-bar', 'token-line', 'token-heatmap']
  );
  assert.deepEqual(
    migrated.compact.items.map((item) => item.y),
    [0, 7, 14, 20, 27, 33, 33, 33, 37, 43, 49]
  );
  assert.deepEqual(
    migrated.compact.items.map((item) => item.x),
    [0, 0, 0, 0, 0, 0, 4, 8, 0, 0, 0]
  );
});

test('validation removes unknown and duplicate ids but restores missing records', () => {
  const result = policy.validateLayout('compact', {
    columns: 12,
    items: [
      { id: 'balance-card', x: 0, y: 0, w: 4, h: 4, preset: 'compact' },
      { id: 'balance-card', x: 0, y: 4, w: 4, h: 4, preset: 'compact' },
      { id: 'missing', x: 0, y: 8, w: 4, h: 4, preset: 'standard' }
    ]
  });

  assert.deepEqual(
    result.items.map((item) => item.id).sort(),
    ['balance-card', 'cache-rate-card', 'cost-line', 'model-bar', 'provider-bar', 'quota-codex', 'quota-kimi', 'today-cost-card', 'token-heatmap', 'token-line', 'token-speed']
  );
  assert.equal(new Set(result.items.map((item) => item.id)).size, 11);
});

test('validation commits legal preset geometry and resolves overlap', () => {
  const result = policy.validateLayout('wide', {
    columns: 12,
    items: [
      { id: 'balance-card', x: 9, y: 0, w: 11, h: 5, preset: 'invalid' },
      { id: 'model-bar', x: 0, y: 0, w: 6, h: 9, preset: 'half' },
      { id: 'token-line', x: 0, y: 0, w: 6, h: 9, preset: 'half' },
      { id: 'cost-line', x: 0, y: 13, w: 12, h: 9, preset: 'full' }
    ]
  });

  const fee = result.items.find((item) => item.id === 'balance-card');
  assert.equal(fee.preset, 'wide');
  assert.deepEqual({ w: fee.w, h: fee.h }, { w: 6, h: 4 });
  assert.ok(result.items.every((item) => item.x + item.w <= 12));

  for (let i = 0; i < result.items.length; i += 1) {
    for (let j = i + 1; j < result.items.length; j += 1) {
      assert.equal(policy.overlaps(result.items[i], result.items[j]), false);
    }
  }
});

test('one malformed breakpoint does not reset the other', () => {
  const wide = policy.defaultLayout('wide');
  wide.items[0].y = 20;

  const state = policy.validateState({
    version: policy.VERSION,
    compact: { columns: 12, items: 'bad' },
    wide
  });

  assert.deepEqual(state.compact, policy.defaultLayout('compact'));
  assert.equal(state.wide.items[0].y, 20);
});

test('store leaves layout null until migration runs', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/store.js'),
    'utf8'
  );
  assert.match(source, /layout:\s*null/);
});
