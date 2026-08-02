const test = require('node:test');
const assert = require('node:assert/strict');

test('reflow animator inverts neighbor movement and settles next frame', () => {
  const frames = [];
  global.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };

  delete require.cache[require.resolve('../src/renderer/js/layout/reflow-animator')];
  const animator = require('../src/renderer/js/layout/reflow-animator');
  let rect = { left: 10, top: 20 };
  const classes = new Set();
  const element = {
    style: {},
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    },
    getBoundingClientRect: () => rect
  };
  const container = { querySelectorAll: () => [element] };

  animator.capture(container, null);
  rect = { left: 40, top: 55 };
  animator.play(container, null);

  assert.equal(element.style.transform, 'translate3d(-30px, -35px, 0)');
  assert.equal(classes.has('layout-reflowing'), true);
  frames.shift()();
  assert.equal(element.style.transform, '');

  delete global.requestAnimationFrame;
});

test('reflow animator excludes the active element', () => {
  const active = { style: {}, classList: { contains: () => false } };
  const container = { querySelectorAll: () => [active] };
  const animator = require('../src/renderer/js/layout/reflow-animator');
  animator.capture(container, active);
  animator.play(container, active);
  assert.equal(active.style.transform, undefined);
});
