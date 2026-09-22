const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const miniView = fs.readFileSync(path.join(root, 'renderer/src/components/MiniView.jsx'), 'utf8');
const settingsDefinitions = fs.readFileSync(path.join(root, 'src/renderer/js/settings-definitions.js'), 'utf8');
const settingsWindow = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');
const registry = require('../src/renderer/js/layout/component-registry.js');
const { PROVIDER_IDS, parseRowOrder } = require('../src/shared/mini-row-order');

test('mini view rows are orderable via window.miniRowOrder with four known providers', () => {
  assert.deepEqual(PROVIDER_IDS, ['deepseek', 'codex', 'kimi', 'dsh']);
  assert.match(miniView, /globalThis.MiniRowOrder/);
  assert.match(miniView, /window\.miniRowOrder|miniRowOrder/);
  // 未知项丢弃、缺失项补尾的归一逻辑必须存在
  assert.match(miniView, /parseRowOrder/);
});

test('row normalization removes duplicates and unknown ids without mutating the input', () => {
  const input = [' kimi ', 'unknown', 'kimi', 'deepseek'];
  assert.deepEqual(parseRowOrder(input), ['kimi', 'deepseek', 'codex', 'dsh']);
  assert.deepEqual(input, [' kimi ', 'unknown', 'kimi', 'deepseek']);
  assert.deepEqual(parseRowOrder('dsh,codex,dsh'), ['dsh', 'codex', 'deepseek', 'kimi']);
  assert.deepEqual(parseRowOrder(null), PROVIDER_IDS);
});

test('mini view deepseek/dsh rows share the DeepSeek balance at 100 yuan full scale', () => {
  assert.match(miniView, /RING_FULL_YUAN = 100/);
  assert.match(miniView, /amountFrac\(balanceTotal\)/);
  for (const provider of ['deepseek', 'dsh']) {
    assert.ok(miniView.includes(`${provider}: <Ring outer={amountFrac(balanceTotal)} color={PROVIDER_META.${provider}.color} label={amountLabel(balanceTotal)} />`));
  }
  // Ring 支持自定义环内数字标签
  assert.match(miniView, /label !== undefined \? label/);
});

test('settings expose the mini row order editor bound to window.miniRowOrder', () => {
  const context = { window: { ComponentRegistry: registry } };
  vm.runInNewContext(settingsDefinitions, context, { filename: 'settings-definitions.js' });
  const definitions = Array.from(context.window.SettingsDefinitions);
  const def = definitions.find((item) => item.key === 'window.miniRowOrder');
  assert.ok(def);
  assert.equal(def.type, 'miniRowOrder');
  assert.equal(def.default, 'deepseek,codex,kimi,dsh');
  // 设置窗口渲染该类型并绑定上移/下移保存
  assert.match(settingsWindow, /case 'miniRowOrder'/);
  assert.match(settingsWindow, /mini-order-btn/);
  assert.match(settingsWindow, /order\.join\(','\)/);
});
