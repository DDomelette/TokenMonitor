const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../src/renderer/js/layout/component-registry.js');

async function loadResizeEngine() {
  return import('../renderer/src/grid/resize-engine.js');
}

test('similar components inherit one structure from the registry', () => {
  const cards = ['balance-card', 'today-cost-card', 'cache-rate-card'].map(registry.get);
  cards.forEach((card) => {
    assert.deepEqual(card.minSize, { w: 4, h: 3 });
    assert.equal(card.renderer, 'fee');
    assert.equal(card.itemClass, 'fee-card-widget');
    assert.equal(card.surfaceClass, 'fee-card-surface');
    assert.equal(card.showTitle, true);
    assert.equal(card.autoFit, true);
  });

  const quotas = ['quota-codex', 'quota-kimi'].map(registry.get);
  quotas.forEach((quota) => {
    assert.deepEqual(quota.minSize, { w: 6, h: 5 });
    assert.equal(quota.renderer, 'quota');
    assert.equal(quota.requiresProvider, true);
    assert.equal(quota.surfaceClass, 'embed-surface');
  });
});

test('component-specific behavior is an explicit registry override', () => {
  assert.equal(registry.get('provider-bar').renderer, 'provider-bar');
  assert.equal(registry.get('provider-bar').usesChartRange, true);
  assert.equal(registry.get('token-speed').renderer, 'token-speed');
  assert.equal(registry.get('token-speed').usesChartRange, false);
  assert.equal(registry.get('token-speed').surfaceClass, 'chart-surface embed-surface');
  assert.equal(registry.get('token-heatmap').renderer, 'heatmap');
});

test('Dashboard consumes registered structure instead of per-id layout lists', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/components/Dashboard.jsx'),
    'utf8'
  );
  assert.match(source, /RegisteredWidgetBody/);
  assert.match(source, /getComponent\(item\.id\)/);
  assert.match(source, /component\.autoFit/);
  assert.match(source, /engineClass: DashboardGridEngine/);
  ['LABELS', 'FEE_IDS', 'QUOTA_IDS', 'EMBED_IDS', 'CHART_IDS', 'MIN_SIZES'].forEach((name) => {
    assert.doesNotMatch(source, new RegExp(`const\\s+${name}\\s*=`), name);
  });
});

test('isolated resize changes only the active node and emits one notification', async () => {
  const { applyIsolatedResize } = await loadResizeEngine();
  const active = { id: 'active', x: 0, y: 2, w: 4, h: 4, minW: 4, minH: 3 };
  const neighbor = { id: 'neighbor', x: 4, y: 2, w: 4, h: 4 };
  const before = { ...neighbor };
  let notifications = 0;
  const engine = {
    changedPosConstrain: () => true,
    nodeBoundFix: () => {},
    _notify: () => { notifications += 1; }
  };

  const changed = applyIsolatedResize(engine, active, {
    x: 0, y: 2, w: 8, h: 7, resizing: true
  });

  assert.equal(changed, true);
  assert.deepEqual({ x: active.x, y: active.y, w: active.w, h: active.h }, { x: 0, y: 2, w: 8, h: 7 });
  assert.equal(active._dirty, true);
  assert.deepEqual(neighbor, before);
  assert.equal(notifications, 1);
});

test('isolated resize enforces bounds without running collision packing', async () => {
  const { applyIsolatedResize } = await loadResizeEngine();
  const active = { id: 'active', x: 8, y: 2, w: 4, h: 4, minW: 4, minH: 3 };
  const engine = {
    column: 12,
    changedPosConstrain: () => true,
    nodeBoundFix(node) {
      node.w = Math.max(node.minW, Math.min(this.column - node.x, node.w));
      node.h = Math.max(node.minH, node.h);
    },
    _notify: () => {}
  };

  applyIsolatedResize(engine, active, { x: 8, y: 2, w: 10, h: 2, resizing: true });
  assert.deepEqual({ w: active.w, h: active.h }, { w: 4, h: 3 });
});

test('ordinary drag operations still use the native GridStack engine', async () => {
  const { createResizeIsolatedEngine } = await loadResizeEngine();
  class BaseEngine {
    moveNodeCheck() { return 'native-move'; }
  }
  const Engine = createResizeIsolatedEngine({ Engine: BaseEngine });
  const engine = new Engine();
  assert.equal(engine.moveNodeCheck({}, { x: 2, y: 3 }), 'native-move');
});

test('resize limit feedback derives maximum dimensions from registered presets', async () => {
  const { isResizeBeyondLimits } = await loadResizeEngine();
  const card = registry.get('balance-card');
  const chart = registry.get('model-bar');

  assert.equal(isResizeBeyondLimits(card, 'wide', { w: 4, h: 4 }, { w: 6, h: 4 }), false);
  assert.equal(isResizeBeyondLimits(card, 'wide', { w: 4, h: 4 }, { w: 7, h: 4 }), true);
  assert.equal(isResizeBeyondLimits(chart, 'wide', { w: 12, h: 8 }, { w: 12, h: 10 }), false);
  assert.equal(isResizeBeyondLimits(chart, 'wide', { w: 12, h: 8 }, { w: 12, h: 11 }), true);
});

test('automatic content height does not cause a false resize limit warning', async () => {
  const { isResizeBeyondLimits } = await loadResizeEngine();
  const card = registry.get('balance-card');

  assert.equal(isResizeBeyondLimits(card, 'wide', { w: 4, h: 5 }, { w: 6, h: 5 }), false);
  assert.equal(isResizeBeyondLimits(card, 'wide', { w: 4, h: 5 }, { w: 4, h: 6 }), true);
});

test('editing hides arrow images and exposes registered-size feedback', () => {
  const styles = fs.readFileSync(path.resolve(__dirname, '../renderer/src/styles.css'), 'utf8');
  const dashboard = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/components/Dashboard.jsx'),
    'utf8'
  );

  assert.match(styles, /\.ui-resizable-handle\s*\{[^}]*background-image:\s*none/s);
  assert.match(styles, /\.is-resize-invalid/);
  assert.match(styles, /\.resize-limit-feedback/);
  assert.match(dashboard, /isResizeBeyondLimits/);
  assert.match(dashboard, /超过最大尺寸/);
});

test('editing clips content inside card boundaries even when themes allow decorative overflow', () => {
  const styles = fs.readFileSync(path.resolve(__dirname, '../renderer/src/styles.css'), 'utf8');
  assert.match(
    styles,
    /\.grid-stack\.editing\s*>\s*\.grid-stack-item\s*>\s*\.grid-stack-item-content\s*\{[^}]*overflow:\s*hidden\s*!important/s
  );
});
