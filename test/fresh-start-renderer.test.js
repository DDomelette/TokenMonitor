const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('npm start prepares the renderer through prestart', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.prestart, 'npm run build:renderer');
  assert.equal(pkg.scripts.start, 'electron .');
});

test('renderer entry preflight resolves a present build and rejects a missing build clearly', () => {
  const modulePath = path.join(root, 'src', 'main', 'core', 'renderer-entry.js');
  assert.equal(fs.existsSync(modulePath), true, 'renderer entry preflight module must exist');

  const { assertRendererBuild, RENDERER_ENTRY_RELATIVE } = require(modulePath);
  const projectRoot = path.join(path.sep, 'tmp', 'token-monitor');
  const expected = path.join(projectRoot, 'renderer', 'dist', 'index.html');

  assert.equal(
    assertRendererBuild({ projectRoot, existsSync: (candidate) => candidate === expected }),
    expected
  );

  assert.throws(
    () => assertRendererBuild({ projectRoot, existsSync: () => false }),
    (error) => error
      && error.code === 'RENDERER_BUILD_MISSING'
      && error.message.includes(RENDERER_ENTRY_RELATIVE)
      && error.message.includes('npm run build:renderer')
  );
});

test('bootstrap checks the renderer build before store recovery can load the main process', () => {
  const source = read('src/main/bootstrap.js');
  const importIndex = source.indexOf("require('./core/renderer-entry')");
  const checkIndex = source.indexOf('assertRendererBuild(');
  const recoveryIndex = source.indexOf('runStoreBootstrap({');
  const loadMainIndex = source.indexOf("loadMain: () => require('./index')");

  assert.ok(importIndex >= 0, 'bootstrap must import the renderer preflight');
  assert.ok(checkIndex > importIndex, 'bootstrap must execute the preflight');
  assert.ok(checkIndex < recoveryIndex, 'renderer preflight must run before store recovery loads main');
  assert.ok(recoveryIndex < loadMainIndex, 'main loading must remain behind store recovery');
  assert.match(source, /RENDERER_BUILD_MISSING/);
  assert.match(source, /action: 'npm run build:renderer'/);
});

test('CI and quick-start documentation verify a build from an absent renderer dist', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /rm -rf renderer\/dist/);
  assert.match(workflow, /npm run prestart/);
  assert.match(workflow, /test -f renderer\/dist\/index\.html/);

  const readme = read('README.md');
  const quickStart = readme.slice(readme.indexOf('## 快速开始'), readme.indexOf('### 常用命令'));
  assert.match(quickStart, /npm start\s+# 自动构建 renderer 并启动 Electron/);
  assert.doesNotMatch(quickStart, /npm run build:renderer/);
});
