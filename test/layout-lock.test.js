const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadLayoutLock() {
  return import('../renderer/src/layout-lock.js');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('layout lock defaults closed and unlocks only for explicit false', async () => {
  const { isLayoutLocked } = await loadLayoutLock();

  assert.equal(isLayoutLocked(), true);
  assert.equal(isLayoutLocked({}), true);
  assert.equal(isLayoutLocked({ window: {} }), true);
  assert.equal(isLayoutLocked({ window: { layoutLocked: true } }), true);
  assert.equal(isLayoutLocked({ window: { layoutLocked: false } }), false);
  assert.equal(isLayoutLocked({ window: { layoutLocked: 0 } }), true);
  assert.equal(isLayoutLocked({ window: { layoutLocked: 'false' } }), true);
});

test('layout lock sync restores persisted state, applies live changes, ignores stale initial reads, and cleans up', async () => {
  const { installLayoutLockSync } = await loadLayoutLock();
  const initial = deferred();
  let handler = null;
  let unsubscribeCalls = 0;
  const changes = [];

  const cleanup = installLayoutLockSync({
    getSettings: () => initial.promise,
    on(channel, callback) {
      assert.equal(channel, 'settings:loaded');
      handler = callback;
      return () => { unsubscribeCalls += 1; };
    },
    onChange: (locked) => changes.push(locked)
  });

  assert.equal(typeof handler, 'function');
  assert.deepEqual(changes, []);

  handler({ window: { layoutLocked: true } });
  assert.deepEqual(changes, [true]);

  initial.resolve({ window: { layoutLocked: false } });
  await flushEvents();
  assert.deepEqual(changes, [true], 'older initial read must not override a live setting');

  handler({ window: { layoutLocked: false } });
  assert.deepEqual(changes, [true, false]);

  cleanup();
  assert.equal(unsubscribeCalls, 1);
  handler({ window: { layoutLocked: true } });
  assert.deepEqual(changes, [true, false]);
});

test('layout lock sync falls back to the safe locked state when initial settings fail', async () => {
  const { installLayoutLockSync } = await loadLayoutLock();
  const changes = [];

  const cleanup = installLayoutLockSync({
    getSettings: () => Promise.reject(new Error('settings unavailable')),
    on: () => () => {},
    onChange: (locked) => changes.push(locked)
  });

  await flushEvents();
  assert.deepEqual(changes, [true]);
  cleanup();
});

test('App owns the lock, exits editing safely, and passes effective editing to both children', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/App.jsx'),
    'utf8'
  );

  assert.match(source, /import \{ installLayoutLockSync \} from '\.\/layout-lock\.js';/);
  assert.match(source, /const \[layoutLocked, setLayoutLocked\] = useState\(true\);/);
  assert.match(source, /useEffect\(\(\) => installLayoutLockSync\(\{/);
  assert.match(source, /onChange:\s*setLayoutLocked/);
  assert.match(source, /useEffect\(\(\) => \{\s*if \(layoutLocked\) setEditing\(false\);\s*\}, \[layoutLocked\]\);/);
  assert.match(source, /const effectiveEditing = editing && !layoutLocked;/);
  assert.match(source, /if \(!layoutLocked\) setEditing\(\(current\) => !current\);/);
  assert.match(source, /<TitleBar[\s\S]*?editing=\{effectiveEditing\}[\s\S]*?layoutLocked=\{layoutLocked\}/);
  assert.match(source, /<Dashboard\b[^>]*editing=\{effectiveEditing\}[^>]*\/>/);
});

test('TitleBar disables the layout edit control and never renders it active while locked', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/components/TitleBar.jsx'),
    'utf8'
  );

  assert.match(source, /function TitleBar\(\{ editing, layoutLocked, onToggleLayoutEdit \}\)/);
  assert.match(source, /className=\{'titlebar-btn titlebar-btn-layout' \+ \(editing && !layoutLocked \? ' active' : ''\)\}/);
  assert.match(source, /disabled=\{layoutLocked\}/);
  assert.match(source, /aria-disabled=\{layoutLocked \? 'true' : 'false'\}/);
  assert.match(source, /title=\{layoutLocked \? '布局已锁定' : \(editing \? '完成布局编排' : '编辑布局'\)\}/);
});

test('layout lock disabled styling is imported after the existing final overrides', () => {
  const mainSource = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/main.jsx'),
    'utf8'
  );
  assert.match(
    mainSource,
    /import '\.\/theme\.css';\s*import '\.\/layout-lock\.css';/
  );

  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/layout-lock.css'),
    'utf8'
  );
  assert.match(source, /\.titlebar-btn-layout:disabled/);
  assert.match(source, /cursor:\s*not-allowed/);
  assert.match(source, /opacity:/);
}
);
