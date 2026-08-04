const test = require('node:test');
const assert = require('node:assert/strict');

async function loadVisibility() {
  return import('../renderer/src/grid/visibility.js');
}

test('disabled registered components are excluded without mutating layout records', async () => {
  const { visibleComponentIds } = await loadVisibility();
  const layout = {
    items: [
      { id: 'token-line', x: 0, y: 30, w: 12, h: 6 },
      { id: 'cost-line', x: 0, y: 36, w: 12, h: 6 }
    ]
  };
  const before = JSON.parse(JSON.stringify(layout));

  const visible = visibleComponentIds({
    components: { tokenLine: false, costLine: true }
  });

  assert.equal(visible.includes('token-line'), false);
  assert.equal(visible.includes('cost-line'), true);
  assert.deepEqual(layout, before);
});

test('missing component settings use registry defaults and false remains false', async () => {
  const { visibleComponentIds } = await loadVisibility();

  const defaults = visibleComponentIds({});
  assert.equal(defaults.includes('token-line'), true);

  const disabled = visibleComponentIds({ components: { costLine: false } });
  assert.equal(disabled.includes('cost-line'), false);
});
