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

test('a single failed provider shows its actionable summary', async () => {
  const { summarizeProviderHealth } = await loadHealth();
  const health = summarizeProviderHealth([{
    id: 'deepseek',
    displayName: 'DeepSeek',
    authStatus: 'ok',
    lastError: '代理连接失败',
    lastFailedAt: 2000,
    lastFetchedAt: null,
    stale: false
  }]);

  assert.equal(health.mode, 'error');
  assert.equal(health.running, false);
  assert.equal(health.text, '获取失败：DeepSeek 代理连接失败');
  assert.equal(health.lastFetchedAt, null);
});

test('a healthy provider plus a failed provider reports degraded availability', async () => {
  const { summarizeProviderHealth } = await loadHealth();
  const health = summarizeProviderHealth([
    {
      id: 'codex',
      displayName: 'Codex',
      authStatus: 'ok',
      lastError: null,
      lastFetchedAt: 3000,
      stale: false
    },
    {
      id: 'deepseek',
      displayName: 'DeepSeek',
      authStatus: 'ok',
      lastError: '请求超时',
      lastFailedAt: 4000,
      lastFetchedAt: null,
      stale: false
    }
  ]);

  assert.equal(health.mode, 'degraded');
  assert.equal(health.running, true);
  assert.equal(health.text, '部分数据不可用：DeepSeek 请求超时');
  assert.equal(health.lastFetchedAt, 3000);
});

test('a healthy provider keeps the global state degraded when another provider has stale retained data', async () => {
  const { summarizeProviderHealth } = await loadHealth();
  const health = summarizeProviderHealth([
    {
      id: 'kimi',
      displayName: 'Kimi',
      authStatus: 'ok',
      lastError: null,
      lastFetchedAt: 5000,
      stale: false
    },
    {
      id: 'codex',
      displayName: 'Codex',
      authStatus: 'ok',
      lastError: 'HTTP 503 Service Unavailable',
      lastFailedAt: 6000,
      lastFetchedAt: 2000,
      stale: true
    }
  ]);

  assert.equal(health.mode, 'degraded');
  assert.equal(health.running, true);
  assert.match(health.text, /Codex HTTP 503 Service Unavailable/);
  assert.equal(health.lastFetchedAt, 5000);
});

test('provider health styles include a distinct degraded warning state', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/provider-health.css'),
    'utf8'
  );

  assert.match(source, /\.status-dot\.degraded\s*\{/);
  assert.match(source, /\.status-dot\.degraded\s*\{[\s\S]*?var\(--provider-health-warning\)/);
});
