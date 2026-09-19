const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('settings rerenders do not multiply the reset confirmation or reset operation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/settings-window.js'), 'utf8');
  const elements = Object.fromEntries(['settingsCloseBtn', 'settingsDoneBtn', 'resetBtn', 'settingsBody']
    .map((id) => [id, new EventTarget()]));
  let confirmations = 0;
  let resets = 0;
  const context = {
    document: { getElementById: (id) => elements[id] || null, querySelectorAll: () => [] },
    window: {
      confirm() { confirmations++; return true; },
      api: { send(channel) { if (channel === 'settings:reset') resets++; } }
    },
    requestSettingsClose() {},
    getNested() {},
    buildSessionSection: () => '',
    buildPanel: () => '',
    syncProxyControls() {},
    mcpConnection: { load() {} },
    ingestConnection: { load() {} },
    updateSessionSection() {},
    applyInitialTheme() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function bindWindowEvents()'), source.indexOf('  function closeAllSelects()')), context);
  vm.runInContext(source.slice(source.indexOf('  function renderAll(settings)'), source.indexOf("  window.api.on('settings:loaded'")), context);
  for (let i = 0; i < 3; i++) context.renderAll({});
  elements.resetBtn.dispatchEvent(new Event('click'));
  assert.equal(confirmations, 1);
  assert.equal(resets, 1);
});
