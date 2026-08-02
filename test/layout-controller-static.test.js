const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const controllerPath = path.join(
  root,
  'src/renderer/js/layout/layout-controller.js'
);

test('layout controller exposes the approved public contract', () => {
  const source = fs.readFileSync(controllerPath, 'utf8');
  ['init', 'setEditing', 'isEditing', 'setComponentVisible', 'applySettings', 'resize', 'destroy']
    .forEach((name) => assert.match(source, new RegExp(name + ':')));
});

test('layout controller configures GridStack without native window geometry', () => {
  const source = fs.readFileSync(controllerPath, 'utf8');
  assert.match(source, /GridStack\.init/);
  assert.doesNotMatch(source, /cellHeight:\s*'auto'/);
  assert.match(source, /cellHeight:\s*24/);
  assert.match(source, /function computeResponsiveCellHeight/);
  assert.match(source, /function updateResponsiveCellHeight/);
  assert.match(source, /function syncAspectRatioWidgets/);
  assert.match(source, /component\.aspectRatio/);
  assert.match(source, /grid\.cellWidth\(\)/);
  assert.match(source, /grid\.update\(element,\s*\{\s*h:\s*targetRows\s*\}\)/);
  assert.match(source, /content\.clientHeight/);
  assert.match(source, /grid\.cellHeight\(computeResponsiveCellHeight\(\)\)/);
  assert.match(source, /margin:\s*12/);
  assert.match(source, /handle:\s*'\.component-title'/);
  assert.doesNotMatch(source, /setBounds|setSize|setPosition|window:commit/);
});

test('legacy drag sort is no longer initialized', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/js/app.js'), 'utf8');
  assert.doesNotMatch(app, /initDragSort/);
});

test('layout records retain their preset name in the DOM', () => {
  const source = fs.readFileSync(controllerPath, 'utf8');
  assert.match(source, /var presetName = preset\.name \|\| preset\.preset;/);
  assert.match(source, /element\.dataset\.layoutPreset = presetName;/);
});

test('settings reset immediately migrates and persists a fresh layout', () => {
  const source = fs.readFileSync(controllerPath, 'utf8');
  const applySettings = source.match(
    /function applySettings\([\s\S]*?\n  function setComponentVisible/
  );
  assert.ok(applySettings);
  assert.match(applySettings[0], /validateState\(settings\.layout, settings\)/);
  assert.doesNotMatch(applySettings[0], /if \(settings\.layout\)/);
  assert.match(applySettings[0], /key: 'layout'/);
});

test('layout changes animate neighbors and charts resize through registry hooks', () => {
  const controller = fs.readFileSync(controllerPath, 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/renderer/js/app.js'), 'utf8');
  const curve = fs.readFileSync(
    path.join(root, 'src/renderer/js/components/curve-chart.js'),
    'utf8'
  );
  const daily = fs.readFileSync(
    path.join(root, 'src/renderer/js/components/model-bar.js'),
    'utf8'
  );

  assert.match(controller, /ReflowAnimator\.capture/);
  assert.match(controller, /ReflowAnimator\.play/);
  assert.match(app, /ComponentRegistry\.getRuntime/);
  assert.match(curve, /registerRuntime\('token-line'/);
  assert.match(curve, /registerRuntime\('cost-line'/);
  assert.match(daily, /registerRuntime\('model-bar'/);
});

test('registry can opt specific widgets out of GridStack resizing', () => {
  const source = fs.readFileSync(controllerPath, 'utf8');
  assert.match(source, /component\.resizable === false/);
  assert.match(source, /gs-no-resize/);
  assert.match(source, /noResize/);
});

test('chart tooltips render outside widget clipping boundaries', () => {
  const curve = fs.readFileSync(
    path.join(root, 'src/renderer/js/components/curve-chart.js'),
    'utf8'
  );
  const daily = fs.readFileSync(
    path.join(root, 'src/renderer/js/components/model-bar.js'),
    'utf8'
  );

  assert.match(daily, /appendToBody:\s*true/);
  assert.match(daily, /confine:\s*false/);
  assert.ok((curve.match(/appendToBody:\s*true/g) || []).length >= 2);
  assert.ok((curve.match(/confine:\s*false/g) || []).length >= 2);
  assert.doesNotMatch(curve, /confine:\s*true/);
});

test('curve chart axes adapt immediately to widget resize', () => {
  const curve = fs.readFileSync(
    path.join(root, 'src/renderer/js/components/curve-chart.js'),
    'utf8'
  );

  assert.match(curve, /function adaptiveAxisOptions/);
  assert.match(curve, /function dateLabelInterval/);
  assert.match(curve, /dataPointCount/);
  assert.match(curve, /hideOverlap:\s*true/);
  assert.match(curve, /axisLabel:\s*Object\.assign\(\{\s*show:\s*true/);
  assert.match(curve, /fontSize:\s*axisFontSize/);
  assert.match(curve, /interval:\s*dateLabelInterval\(dataPointCount,\s*width\)/);
  assert.match(curve, /chart\.resize\(\{ width: chartDom\.clientWidth, height: chartDom\.clientHeight \}\);[\s\S]*applyDensity\(\);/);
});

test('native window resize updates grid sizing and chart repaints during resize', () => {
  const controller = fs.readFileSync(controllerPath, 'utf8');
  const app = fs.readFileSync(path.join(root, 'src/renderer/js/app.js'), 'utf8');

  const appResizeListener = app.match(/window\.addEventListener\('resize'[\s\S]*?\n    \}\);/);
  assert.ok(appResizeListener);
  assert.doesNotMatch(appResizeListener[0], /if \(!ws\.resizing\) scheduleChartResize\(\);/);
  assert.match(appResizeListener[0], /scheduleChartResize\(\);/);

  const mouseupHandler = app.match(/document\.addEventListener\('mouseup'[\s\S]*?\n  \}\);/);
  assert.ok(mouseupHandler);
  assert.match(mouseupHandler[0], /window\.api\.send\('resize:end'\);[\s\S]*scheduleChartResize\(\);/);

  const layoutResize = controller.match(/function resize\(\)[\s\S]*?\n  function destroy/);
  assert.ok(layoutResize);
  assert.match(layoutResize[0], /updateResponsiveCellHeight\(\);/);
  assert.match(layoutResize[0], /syncAspectRatioWidgets\(\);/);
  assert.doesNotMatch(layoutResize[0], /if \(window\._ws && window\._ws\.resizing\) return;/);
  assert.match(layoutResize[0], /scheduleChartResize\(\);/);
});

test('ctrl wheel zooms the whole page through the main process', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/js/app.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');

  assert.doesNotMatch(app, /adjustFontScale|--ui-font-scale/);
  assert.match(app, /window\.api\.send\('zoom:change'/);
  assert.match(main, /ipcMain\.on\('zoom:change'/);
  assert.match(main, /webContents\.setZoomFactor\(next\)/);
});
