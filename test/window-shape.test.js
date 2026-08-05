const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function loadWindowShape() {
  const modulePath = require.resolve('../src/main/core/window-shape');
  delete require.cache[modulePath];
  return require(modulePath);
}

function contains(rects, x, y) {
  return rects.some((rect) => (
    x >= rect.x
    && x < rect.x + rect.width
    && y >= rect.y
    && y < rect.y + rect.height
  ));
}

function spanAt(rects, y) {
  const row = rects.filter((rect) => y >= rect.y && y < rect.y + rect.height);
  assert.equal(row.length, 1, `expected exactly one shape span at y=${y}`);
  return { x: row[0].x, width: row[0].width };
}

test('rounded shape excludes all outer corners while keeping the center and edge centers', () => {
  const { buildRoundedWindowShape } = loadWindowShape();
  const rects = buildRoundedWindowShape(100, 80, 16);

  assert.equal(contains(rects, 0, 0), false);
  assert.equal(contains(rects, 99, 0), false);
  assert.equal(contains(rects, 0, 79), false);
  assert.equal(contains(rects, 99, 79), false);

  assert.equal(contains(rects, 50, 0), true);
  assert.equal(contains(rects, 50, 79), true);
  assert.equal(contains(rects, 0, 40), true);
  assert.equal(contains(rects, 99, 40), true);
  assert.equal(contains(rects, 50, 40), true);
});

test('rounded shape rectangles are bounded, positive, integer, and vertically symmetric', () => {
  const { buildRoundedWindowShape } = loadWindowShape();
  const width = 421;
  const height = 683;
  const rects = buildRoundedWindowShape(width, height, 16);

  for (const rect of rects) {
    assert.equal(Number.isInteger(rect.x), true);
    assert.equal(Number.isInteger(rect.y), true);
    assert.equal(Number.isInteger(rect.width), true);
    assert.equal(Number.isInteger(rect.height), true);
    assert.ok(rect.x >= 0);
    assert.ok(rect.y >= 0);
    assert.ok(rect.width > 0);
    assert.ok(rect.height > 0);
    assert.ok(rect.x + rect.width <= width);
    assert.ok(rect.y + rect.height <= height);
  }

  for (let y = 0; y < 16; y += 1) {
    assert.deepEqual(spanAt(rects, y), spanAt(rects, height - 1 - y));
  }
});

test('rounded shape clamps oversized radii and small dimensions safely', () => {
  const { buildRoundedWindowShape } = loadWindowShape();

  assert.deepEqual(buildRoundedWindowShape(0, 10, 16), []);
  assert.deepEqual(buildRoundedWindowShape(10, 0, 16), []);

  const rects = buildRoundedWindowShape(9.8, 5.2, 99);
  assert.ok(rects.length > 0);
  assert.equal(contains(rects, 4, 2), true);
  assert.equal(contains(rects, 0, 0), false);
  for (const rect of rects) {
    assert.ok(rect.x + rect.width <= 9);
    assert.ok(rect.y + rect.height <= 5);
  }
});

test('native rounded shape is applied from the current content size on Windows and Linux', () => {
  const { applyRoundedWindowShape } = loadWindowShape();

  for (const platform of ['win32', 'linux']) {
    const calls = [];
    const win = {
      getContentSize: () => [420, 680],
      setShape: (rects) => calls.push(rects)
    };

    assert.equal(applyRoundedWindowShape(win, { platform, radius: 16 }), true);
    assert.equal(calls.length, 1);
    assert.equal(contains(calls[0], 0, 0), false);
    assert.equal(contains(calls[0], 210, 340), true);
  }
});

test('native shape is a safe no-op on macOS or when setShape is unavailable', () => {
  const { applyRoundedWindowShape } = loadWindowShape();
  let calls = 0;
  const win = {
    getContentSize: () => [420, 680],
    setShape: () => { calls += 1; }
  };

  assert.equal(applyRoundedWindowShape(win, { platform: 'darwin', radius: 16 }), false);
  assert.equal(calls, 0);
  assert.equal(
    applyRoundedWindowShape({ getContentSize: () => [420, 680] }, { platform: 'win32' }),
    false
  );
});

test('bootstrap observer shapes only the main renderer and reapplies after resize', () => {
  const { installRoundedMainWindowShapeObserver } = loadWindowShape();
  const app = new EventEmitter();
  const webContents = new EventEmitter();
  const win = new EventEmitter();
  let size = [420, 680];
  const calls = [];
  win.webContents = webContents;
  win.getContentSize = () => size;
  win.setShape = (rects) => calls.push(rects);

  assert.equal(
    installRoundedMainWindowShapeObserver(app, { platform: 'linux', radius: 16 }),
    true
  );
  app.emit('browser-window-created', {}, win);

  webContents.emit(
    'did-start-navigation',
    {},
    'file:///tmp/TokenMonitor/src/renderer/login.html'
  );
  assert.equal(calls.length, 0);

  webContents.emit(
    'did-start-navigation',
    {},
    'file:///tmp/TokenMonitor/renderer/dist/index.html'
  );
  assert.equal(calls.length, 1);
  assert.equal(contains(calls[0], 0, 0), false);

  size = [600, 300];
  win.emit('resize');
  assert.equal(calls.length, 2);
  assert.equal(contains(calls[1], 300, 150), true);

  webContents.emit(
    'did-navigate',
    {},
    'file:///tmp/TokenMonitor/renderer/dist/index.html'
  );
  assert.equal(calls.length, 2, 'observer must not install duplicate resize handlers');
});

test('bootstrap installs the main-window shape observer before loading index.js', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/main/bootstrap.js'),
    'utf8'
  );

  assert.match(source, /require\('\.\/core\/window-shape'\)/);
  assert.match(
    source,
    /installRoundedMainWindowShapeObserver\(app\)[\s\S]*?loadMain:\s*\(\)\s*=>\s*require\('\.\/index'\)/
  );
});

test('React root clips all child content to the shared window radius', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/styles.css'),
    'utf8'
  );
  const appBlock = /#app\s*\{([\s\S]*?)\}/.exec(source);
  assert.ok(appBlock, '#app style block must exist');
  assert.match(appBlock[1], /border-radius:\s*var\(--radius-window\)/);
  assert.match(appBlock[1], /overflow:\s*hidden/);

  const rootBlock = /html,\s*\nbody,\s*\n#root\s*\{([\s\S]*?)\}/.exec(source);
  assert.ok(rootBlock, 'html/body/#root style block must exist');
  assert.match(rootBlock[1], /background:\s*transparent/);
});
