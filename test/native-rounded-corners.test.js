const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// 圆角已转向原生方案(roundedCorners: true 由 DWM 合成层裁剪),
// 自定义 setShape 裁剪与 CSS 圆角叠加会产生角部灰点/最大化灰边,全部移除。
test('custom setShape module and renderer override are removed', () => {
  assert.equal(fs.existsSync(path.join(root, 'src/main/core/window-shape.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'renderer/src/window-shape.css')), false);
});

test('bootstrap no longer installs the rounded shape observer', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/bootstrap.js'), 'utf8');

  assert.doesNotMatch(source, /window-shape/);
  assert.doesNotMatch(source, /installRoundedMainWindowShapeObserver/);
});

test('React entry no longer imports the window-shape override and styles drop the radius token', () => {
  const main = fs.readFileSync(path.join(root, 'renderer/src/main.jsx'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'renderer/src/styles.css'), 'utf8');

  assert.doesNotMatch(main, /window-shape\.css/);
  assert.doesNotMatch(styles, /--radius-window/);
});

test('main window relies on native rounded corners only', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');

  const mainWindow = source.match(/mainWindow = new BrowserWindow\(\{[\s\S]*?\}\);/);
  assert.ok(mainWindow, 'main window options must exist');
  assert.match(mainWindow[0], /roundedCorners: true/);
  assert.doesNotMatch(mainWindow[0], /transparent: true/);
});
