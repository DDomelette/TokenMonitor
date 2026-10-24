const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('all themes share the shen-chan quota-bar box metrics', () => {
  const base = fs.readFileSync(path.join(root, 'renderer/src/styles.css'), 'utf8');
  const shen = fs.readFileSync(path.join(root, 'renderer/src/shen-chan.css'), 'utf8');
  const baseRule = base.match(/\.quota-bar \{([^}]+)\}/);
  const shenRule = shen.match(/:root\[data-theme='shen-chan'\] \.quota-bar \{([^}]+)\}/);

  assert.ok(baseRule);
  assert.ok(shenRule);
  assert.match(baseRule[1], /height: 10px/);
  assert.match(baseRule[1], /margin-top: 26px/);
  assert.match(baseRule[1], /border: 1px solid transparent/);
  assert.doesNotMatch(shenRule[1], /height:|margin-top:|position:|overflow:/);
});

test('theme changes synchronously schedule grid content refitting', () => {
  const dashboard = fs.readFileSync(path.join(root, 'renderer/src/components/Dashboard.jsx'), 'utf8');

  assert.match(dashboard, /window\.addEventListener\('tokenmonitor:theme-applied', scheduleFit\)/);
  assert.match(dashboard, /window\.removeEventListener\('tokenmonitor:theme-applied', scheduleFit\)/);
});
