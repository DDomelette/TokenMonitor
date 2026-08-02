const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const registry = require('../src/main/providers/registry');

test('main process registers all three provider adapters on startup', () => {
  const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
  assert.match(main, /require\('\.\/providers\/deepseek'\)/);
  assert.match(main, /require\('\.\/providers\/codex'\)/);
  assert.match(main, /require\('\.\/providers\/kimi'\)/);
  const registrations = main.match(/registry\.register\(\w+Provider\)/g) || [];
  assert.equal(registrations.length, 3);
});

test('registry registers, lists and gets adapters', () => {
  const a = { id: 'alpha', displayName: 'Alpha', capabilities: {} };
  const b = { id: 'beta', displayName: 'Beta', capabilities: {} };
  registry.register(a);
  registry.register(b);
  try {
    assert.equal(registry.get('alpha'), a);
    assert.equal(registry.get('beta'), b);
    assert.equal(registry.list().length, 2);
    assert.ok(registry.list().some(function (x) { return x.id === 'alpha'; }));
    assert.ok(registry.list().some(function (x) { return x.id === 'beta'; }));
  } finally {
    registry.list().forEach(function (x) { registry.unregister(x.id); });
  }
});

test('registry.get returns undefined for unknown id', () => {
  assert.equal(registry.get('nope'), undefined);
});

test('registry dedupes re-registration of the same id', () => {
  const a1 = { id: 'dup', displayName: 'One', capabilities: {} };
  const a2 = { id: 'dup', displayName: 'Two', capabilities: {} };
  registry.register(a1);
  registry.register(a2);
  try {
    const all = registry.list().filter(function (x) { return x.id === 'dup'; });
    assert.equal(all.length, 1);
    assert.equal(registry.get('dup').displayName, 'Two');
  } finally {
    registry.unregister('dup');
  }
});
