const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../src/renderer/js/layout/component-registry');

const html = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/index.html'),
  'utf8'
);
const mainCss = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/css/main.css'),
  'utf8'
);
const layoutCss = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/css/layout.css'),
  'utf8'
);
const appJs = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/js/app.js'),
  'utf8'
);

test('dashboard loads local GridStack assets', () => {
  assert.match(html, /node_modules\/gridstack\/dist\/gridstack\.min\.css/);
  assert.match(html, /node_modules\/gridstack\/dist\/gridstack-all\.js/);
  assert.match(html, /css\/layout\.css/);
});

test('each registered component is a grid item with a content surface', () => {
  registry.list().forEach((component) => {
    assert.match(html, new RegExp('data-component-id="' + component.id + '"'));
  });
  assert.equal((html.match(/grid-stack-item-content/g) || []).length, registry.list().length);
});

test('existing chart hosts and independent fee card hosts remain addressable', () => {
  [
    'balance-card-content',
    'today-cost-card-content',
    'cache-rate-card-content',
    'daily-chart',
    'token-chart',
    'cost-chart'
  ].forEach((id) => {
    assert.match(html, new RegExp('id="' + id + '"'));
  });
  assert.doesNotMatch(html, /id="fee-cards-content"/);
});

test('GridStack owns widget height without legacy id minimums', () => {
  assert.doesNotMatch(mainCss, /#(?:fee-cards|balance-card|today-cost-card|cache-rate-card)\s*\{[^}]*min-height/s);
  assert.doesNotMatch(mainCss, /#model-bar\s*\{[^}]*min-height/s);
  assert.doesNotMatch(mainCss, /#token-line\s*,\s*#cost-line\s*\{[^}]*min-height/s);
});

test('titlebar and dashboard padding stay compact', () => {
  assert.match(mainCss, /\.titlebar\s*\{[\s\S]*?padding:\s*0 14px 4px;/);
  assert.match(mainCss, /\.titlebar\s*\{[\s\S]*?margin-top:\s*2px;/);
  assert.match(mainCss, /\.content\s*\{[\s\S]*?padding:\s*0 14px 24px;/);
});

test('main dashboard scrollbar is precise but hidden until hover or scroll', () => {
  assert.match(mainCss, /\.content::-webkit-scrollbar\s*\{[\s\S]*?width:\s*10px;/);
  assert.match(mainCss, /\.content::-webkit-scrollbar-thumb\s*\{[\s\S]*?background:\s*transparent;/);
  assert.match(mainCss, /\.content:hover::-webkit-scrollbar-thumb\s*,\s*\.content\.is-scrolling::-webkit-scrollbar-thumb\s*\{[\s\S]*?background:\s*var\(--border\);/);
  assert.match(appJs, /content\.classList\.add\('is-scrolling'\)/);
  assert.match(appJs, /content\.classList\.remove\('is-scrolling'\)/);
});

test('chart widgets support card collapse without clipping their own content', () => {
  ['model-bar', 'token-line', 'cost-line'].forEach((id) => {
    const section = html.match(new RegExp('<section[^>]*id="' + id + '"[^>]*>|<section[^>]*class="[^"]*"[^>]*id="' + id + '"[^>]*>'));
    assert.ok(section, id);
    assert.match(
      section[0],
      /class="[^"]*chart-widget/
    );
  });
  assert.match(layoutCss, /\.grid-stack\s*\{[\s\S]*?padding-bottom:\s*24px;/);
  assert.match(layoutCss, /\[data-layout-preset="card"\]\s+\.chart-container\s*\{[\s\S]*?min-height:\s*0;/);
  assert.match(layoutCss, /\[data-layout-preset="card"\]\s+\.component-surface\s*\{[\s\S]*?padding:\s*10px;/);
});

test('grid items and chart surfaces never create nested scrollbars', () => {
  const itemContentRule = layoutCss.match(/\.grid-stack\s*>\s*\.grid-stack-item\s*>\s*\.grid-stack-item-content\s*\{[\s\S]*?\}/);
  assert.ok(itemContentRule);
  assert.match(itemContentRule[0], /overflow:\s*hidden\s*!important;/);
  assert.doesNotMatch(itemContentRule[0], /height:\s*100%;/);
  const surfaceRule = layoutCss.match(/\.component-surface\s*\{[\s\S]*?\}/);
  assert.ok(surfaceRule);
  assert.doesNotMatch(surfaceRule[0], /height:\s*100%;/);
  assert.match(layoutCss, /\.chart-container\s*\{[\s\S]*?overflow:\s*hidden;/);
  assert.match(layoutCss, /\.chart-container\s*\{[\s\S]*?height:\s*100%;/);
});

test('layout edit control and controller replace legacy drag sort', () => {
  assert.match(html, /id="layoutEditBtn"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /js\/layout\/layout-controller\.js/);
  assert.doesNotMatch(html, /js\/components\/drag-sort\.js/);

  const gridstackIndex = html.indexOf('gridstack-all.js');
  const controllerIndex = html.indexOf('js/layout/layout-controller.js');
  const appIndex = html.indexOf('js/app.js');
  assert.ok(gridstackIndex >= 0 && controllerIndex > gridstackIndex);
  assert.ok(appIndex > controllerIndex);
});
