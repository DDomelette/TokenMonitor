const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMaximizedDrag } = require('../src/main/core/maximized-drag');

function fakeWindow(maximized = true) {
  const calls = [];
  return {
    calls,
    maximized,
    bounds: { x: 0, y: 0, width: 1600, height: 900 },
    normal: { x: 200, y: 100, width: 500, height: 700 },
    isDestroyed: () => false,
    isMaximized() { return this.maximized; },
    getBounds() { return { ...this.bounds }; },
    getNormalBounds() { return { ...this.normal }; },
    unmaximize() { this.maximized = false; calls.push(['unmaximize']); },
    setBounds(bounds, animate) { this.bounds = { ...bounds }; calls.push(['setBounds', bounds, animate]); }
  };
}

test('maximized drag restores normal size under the original cursor anchor', () => {
  const win = fakeWindow();
  const drag = createMaximizedDrag({ defer: (callback) => callback() });

  assert.equal(drag.start(win, { screenX: 800, screenY: 20 }), true);
  assert.deepEqual(win.calls, [
    ['unmaximize'],
    ['setBounds', { x: 550, y: 0, width: 500, height: 700 }, false]
  ]);

  assert.equal(drag.move(win, { screenX: 900, screenY: 80 }), true);
  assert.deepEqual(win.bounds, { x: 650, y: 60, width: 500, height: 700 });
  assert.equal(drag.end(win), true);
  assert.equal(drag.move(win, { screenX: 1000, screenY: 100 }), false);
});

test('maximized drag preserves horizontal relative position and rejects invalid owners', () => {
  const win = fakeWindow();
  const other = fakeWindow();
  const drag = createMaximizedDrag({ defer: (callback) => callback() });

  assert.equal(drag.start(win, { screenX: 400, screenY: 30 }), true);
  assert.deepEqual(win.bounds, { x: 275, y: 0, width: 500, height: 700 });
  assert.equal(drag.move(other, { screenX: 500, screenY: 50 }), false);
  assert.equal(drag.end(other), false);
  assert.equal(drag.end(win), true);
});

test('normal windows keep using native app-region dragging', () => {
  const win = fakeWindow(false);
  const drag = createMaximizedDrag({ defer: (callback) => callback() });

  assert.equal(drag.start(win, { screenX: 800, screenY: 20 }), false);
  assert.deepEqual(win.calls, []);
  assert.equal(drag.start(win, null), false);
});

test('maximize drag IPC, state events and renderer opt-out are wired together', () => {
  const root = path.resolve(__dirname, '..');
  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
  const titlebar = fs.readFileSync(path.join(root, 'renderer/src/components/TitleBar.jsx'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');

  for (const channel of ['window:is-maximized', 'window:start-maximized-drag']) {
    assert.match(ipc, new RegExp(channel));
    assert.match(preload, new RegExp(channel));
  }
  for (const channel of ['window:move-maximized-drag', 'window:end-maximized-drag']) {
    assert.match(ipc, new RegExp(channel));
    assert.match(preload, new RegExp(channel));
    assert.match(titlebar, new RegExp(channel));
  }
  assert.match(main, /mainWindow\.on\('maximize', notifyMaximizeState\)/);
  assert.match(main, /mainWindow\.on\('unmaximize', notifyMaximizeState\)/);
  assert.match(titlebar, /titlebar-actions/);
  assert.match(titlebar, /restore-drag/);
});
