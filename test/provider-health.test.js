const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadHealth() {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '../renderer/src/provider-health.mjs')
  );
  moduleUrl.searchParams.set('test', String(Date.now()));
  return import(moduleUrl.href);
}

test('provider health distinguishes retained stale data from an initial failure', async () => {
  const { summarizeProviderHealth } = await loadHealth();

  const stale = summarizeProviderHealth([{
    id: 'fake',
    displayName: 'Fake',
    lastError: 'request timeout',
    lastFetchedAt: 1000,
    stale: true
  }]);
  assert.equal(stale.mode, 'stale');
  assert.equal(stale.running, false);
  assert.match(stale.text, /数据可能已过期/);
  assert.match(stale.text, /Fake/);
  assert.match(stale.text, /request timeout/);
  assert.equal(stale.lastFetchedAt, 1000);

  const failed = summarizeProviderHealth([{
    id: 'fake',
    displayName: 'Fake',
    lastError: 'HTTP 503',
    lastFetchedAt: null,
    stale: false
  }]);
  assert.equal(failed.mode, 'error');
  assert.match(failed.text, /获取失败/);
  assert.equal(failed.lastFetchedAt, null);
});

test('mixed provider failures keep a stale warning attached to the provider with retained data', async () => {
  const { summarizeProviderHealth } = await loadHealth();
  const health = summarizeProviderHealth([
    {
      id: 'retained',
      displayName: 'Retained',
      lastError: 'request timeout',
      lastFailedAt: 1000,
      lastFetchedAt: 500,
      stale: true
    },
    {
      id: 'initial',
      displayName: 'Initial',
      lastError: 'HTTP 503',
      lastFailedAt: 2000,
      lastFetchedAt: null,
      stale: false
    }
  ]);

  assert.equal(health.mode, 'stale');
  assert.match(health.text, /Retained/);
  assert.match(health.text, /request timeout/);
  assert.doesNotMatch(health.text, /Initial|HTTP 503/);
});

test('provider health reports online and uses the latest successful provider timestamp', async () => {
  const { summarizeProviderHealth } = await loadHealth();
  const health = summarizeProviderHealth([
    { id: 'a', lastError: null, lastFetchedAt: 1000, stale: false },
    { id: 'b', lastError: null, lastFetchedAt: 2500, stale: false }
  ]);

  assert.equal(health.mode, 'online');
  assert.equal(health.running, true);
  assert.equal(health.text, '数据连接正常');
  assert.equal(health.lastFetchedAt, 2500);
});

test('StatusBar derives display state from provider snapshots and never resets refresh time on every broadcast', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/components/StatusBar.jsx'),
    'utf8'
  );

  assert.match(source, /summarizeProviderHealth/);
  assert.match(source, /useProviders/);
  assert.match(source, /health\.lastFetchedAt/);
  assert.doesNotMatch(source, /onProvidersChanged/);
  assert.doesNotMatch(source, /setLastRefresh\(Date\.now\(\)\)/);
  assert.match(source, /status-dot \$\{health\.mode\}/);
});

test('provider health styles load last and include distinct stale and error states', () => {
  const entrySource = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/main.jsx'),
    'utf8'
  );
  const styleSource = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/provider-health.css'),
    'utf8'
  );

  assert.match(
    entrySource,
    /import '\.\/layout-lock\.css';\s*import '\.\/provider-health\.css';/
  );
  assert.match(
    styleSource,
    /\.status-dot\.stale\s*\{[\s\S]*?var\(--provider-health-warning\)/
  );
  assert.match(
    styleSource,
    /\.status-dot\.error\s*\{[\s\S]*?var\(--provider-health-error\)/
  );
});
