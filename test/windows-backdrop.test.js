const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const backdrop = require('../src/main/windows-backdrop.js');

function fakeWin(handleValue = 0x1122334455667788n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(handleValue);
  return {
    isDestroyed: () => false,
    getNativeWindowHandle: () => buf
  };
}

test('accent tint follows the acrylic theme in ABGR byte order', () => {
  // SWCA 的 GradientColor 是 ABGR(高字节 alpha,其后 B/G/R),不是 ARGB
  assert.equal(backdrop.tintForTheme('acrylic-light'), 0x14ffffff);
  assert.equal(backdrop.tintForTheme('acrylic-dark'), 0x261c1614); // a=0x26 b=28 g=22 r=20
  assert.equal(backdrop.tintForTheme('dark'), null);
  assert.equal(backdrop.tintForTheme('light'), null);
  assert.equal(backdrop.tintForTheme('system'), null);

  assert.equal(backdrop.isAcrylicTheme('acrylic-light'), true);
  assert.equal(backdrop.isAcrylicTheme('acrylic-dark'), true);
  assert.equal(backdrop.isAcrylicTheme('dark'), false);
});

test('applyAccent enables the accent policy with the theme tint', () => {
  const calls = [];
  const api = {
    enable(hwnd, argb) { calls.push(['enable', hwnd, argb]); return true; },
    disable() { return true; }
  };
  const win = fakeWin();

  assert.equal(backdrop.applyAccent(win, { api, argb: 0x14ffffff, platform: 'win32' }), true);
  assert.deepEqual(calls, [['enable', 0x1122334455667788n, 0x14ffffff]]);
});

test('applyAccent refuses unsupported environments', () => {
  const win = fakeWin();
  const api = { enable: () => true, disable: () => true };

  assert.equal(backdrop.applyAccent(win, { api, platform: 'darwin' }), false);
  assert.equal(backdrop.applyAccent(win, { api: null }), false);
  assert.equal(
    backdrop.applyAccent({ isDestroyed: () => true, getNativeWindowHandle: () => Buffer.alloc(8) }, { api }),
    false
  );
});

test('clearAccent disables the accent policy', () => {
  const calls = [];
  const api = {
    enable() { return true; },
    disable(hwnd) { calls.push(['disable', hwnd]); return true; }
  };

  assert.equal(backdrop.clearAccent(fakeWin(), { api, platform: 'win32' }), true);
  assert.deepEqual(calls, [['disable', 0x1122334455667788n]]);
  assert.equal(backdrop.clearAccent(fakeWin(), { api: null }), false);
  assert.equal(backdrop.clearAccent(fakeWin(), { api, platform: 'linux' }), false);
});

test('main process wires the accent backdrop and focus-state channel', () => {
  const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');

  assert.match(main, /require\('\.\/windows-backdrop'\)/);
  assert.match(main, /applyAccent/);
  assert.match(main, /clearAccent/);
  // 失焦实心化(路线 B)只在 Accent 未生效时下发
  assert.match(main, /'window:focus-state'/);
});

test('windows apply the accent while hidden, then reveal on ready-to-show', () => {
  const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');

  // 对已可见窗口应用 SWCA,DWM 不重算模糊区(纯色,resize 才突变透明);
  // 三个亚克力窗口都必须先隐后显:创建时 show:false,就绪后 reveal
  const creators = ['createMainWindow', 'createLoginWindow', 'createSettingsWindow'];
  for (const name of creators) {
    const start = main.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    const body = main.slice(start, main.indexOf('\nfunction ', start + 1));
    assert.match(body, /show:\s*false/, `${name} must create the window hidden`);
    assert.match(body, /revealWhenReady\(/, `${name} must reveal after backdrop is applied`);
  }
  // reveal 依赖 ready-to-show,并有不触发时的兜底,避免窗口永远不出现
  assert.match(main, /ready-to-show/);
  assert.match(main, /setTimeout\(reveal,\s*\d+\)/);
});

test('main window suspends the accent during native resize, restores afterwards', () => {
  const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');

  // SWCA 亚克力模糊随窗口尺寸每帧重算,边框拖拽缩放时造成严重卡顿;
  // 缩放期间挂起 Accent(暂时实心),缩放结束(resized)再恢复磨砂
  const start = main.indexOf('function createMainWindow(');
  const body = main.slice(start, main.indexOf('\nfunction ', start + 1));
  const resizeHandler = body.match(/on\('resize'[\s\S]*?\n\s*\}\)/);
  assert.ok(resizeHandler, 'main window must have a resize handler');
  assert.match(resizeHandler[0], /clearAccent/, 'resize must suspend the accent');
  const resizedHandler = body.match(/on\('resized'[\s\S]*?\n\s*\}\)/);
  assert.ok(resizedHandler, 'main window must have a resized handler');
  assert.match(resizedHandler[0], /applyBackdropTo/, 'resized must restore the backdrop');
});

test('preload and packaging expose what the accent path needs', () => {
  const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.match(preload, /'window:focus-state'/);
  assert.match(builder, /node_modules\/koffi\/\*\*\/\*/);
  assert.ok(pkg.dependencies.koffi, 'koffi must be a runtime dependency');
});
