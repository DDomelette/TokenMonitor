const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadHealth() {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '../renderer/src/provider-health.mjs')
  );
  moduleUrl.searchParams.set('test', String(Date.now()) + Math.random());
  return import(moduleUrl.href);
}

test('an empty provider snapshot is loading, never online', async () => {
  const { summarizeProviderHealth } = await loadHealth();
  const health = summarizeProviderHealth([]);

  assert.equal(health.mode, 'loading');
  assert.equal(health.running, false);
  assert.equal(health.text, '正在获取数据');
  assert.equal(health.lastFetchedAt, null);
});

test('a non-empty snapshot with every provider missing credentials is explicit', async () => {
  const { summarizeProviderHealth } = await loadHealth();
  const health = summarizeProviderHealth([
    { id: 'codex', authStatus: 'missing', lastError: null, lastFetchedAt: 1000 },
    { id: 'kimi', authStatus: 'missing', lastError: null, lastFetchedAt: null }
  ]);

  assert.equal(health.mode, 'missing');
  assert.equal(health.running, false);
  assert.equal(health.text, '未配置可用凭证');
  assert.equal(health.lastFetchedAt, 1000, 'retained data time remains available without implying connectivity');
});

test('a mixed initial snapshot stays loading when one provider may still fetch', async () => {
  const { summarizeProviderHealth } = await loadHealth();
  const health = summarizeProviderHealth([
    { id: 'codex', authStatus: 'missing', lastError: null, lastFetchedAt: null },
    { id: 'deepseek', authStatus: 'ok', lastError: null, lastFetchedAt: null }
  ]);

  assert.equal(health.mode, 'loading');
  assert.equal(health.text, '正在获取数据');
});

test('a network failure before first success remains distinct from loading and missing', async () => {
  const { summarizeProviderHealth } = await loadHealth();
  const health = summarizeProviderHealth([{
    id: 'deepseek',
    displayName: 'DeepSeek',
    authStatus: 'ok',
    lastError: 'network offline',
    lastFailedAt: 1000,
    lastFetchedAt: null,
    stale: false
  }]);

  assert.equal(health.mode, 'error');
  assert.match(health.text, /获取失败/);
  assert.match(health.text, /network offline/);
});

test('provider health styles expose distinct loading and missing states', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/provider-health.css'),
    'utf8'
  );

  assert.match(source, /\.status-dot\.loading\s*\{/);
  assert.match(source, /\.status-dot\.missing\s*\{/);
});
