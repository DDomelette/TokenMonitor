const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const component = fs.readFileSync(path.join(root, 'renderer/src/components/TokenSpeedCard.jsx'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'renderer/src/hooks/useTokenSpeed.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'renderer/src/api.js'), 'utf8');

test('card exposes both selectors and the live curve surface', () => {
  assert.match(component, /Token 消耗速度/);
  assert.match(component, /data\.tokenSpeed\.providerFilter/);
  assert.match(component, /data\.tokenSpeed\.intervalSeconds/);
  assert.match(component, /token-speed-chart/);
  assert.match(component, /采集中/);
  assert.match(component, /含离线时间/);
});

test('hook loads and subscribes to the dedicated speed snapshot', () => {
  assert.match(hook, /getTokenSpeed/);
  assert.match(hook, /onTokenSpeedChanged/);
  assert.match(api, /get:token-speed/);
  assert.match(api, /token-speed:changed/);
});

test('Dashboard routes token-speed as an embedded chart widget', () => {
  const dashboard = fs.readFileSync(path.join(root, 'renderer/src/components/Dashboard.jsx'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'renderer/src/styles.css'), 'utf8');
  assert.match(dashboard, /import TokenSpeedCard/);
  assert.match(dashboard, /id === 'token-speed'/);
  assert.match(dashboard, /CHART_IDS[\s\S]*?'token-speed'/);
  assert.match(dashboard, /EMBED_IDS[\s\S]*?'token-speed'/);
  assert.match(styles, /\.token-speed-card/);
  assert.match(styles, /\.token-speed-controls/);
  assert.match(styles, /\.token-speed-legend/);
});

test('token speed selectors use the themed custom dropdown (no native select)', () => {
  // 原生 <select> 的展开列表由 OS 渲染:直角、白底,与设置页 custom-select 不一致
  assert.match(component, /import CustomSelect/);
  assert.doesNotMatch(component, /<select/);
  const customSelect = fs.readFileSync(path.join(root, 'renderer/src/components/CustomSelect.jsx'), 'utf8');
  assert.match(customSelect, /themed-select-trigger/);
  assert.match(customSelect, /themed-select-menu/);
  assert.match(customSelect, /themed-select-option/);
  assert.match(customSelect, /drop-up/);
  const styles = fs.readFileSync(path.join(root, 'renderer/src/styles.css'), 'utf8');
  assert.match(styles, /\.themed-select-trigger/);
  assert.match(styles, /\.themed-select-menu/);
  assert.match(styles, /\.themed-select-option\.selected/);
  assert.doesNotMatch(styles, /\.token-speed-select/);
});

test('minimum card mode keeps the compact legend on one row so the curve remains visible', () => {
  const styles = fs.readFileSync(path.join(root, 'renderer/src/styles.css'), 'utf8');
  const compact = styles.slice(styles.indexOf('@container (max-width: 220px)'));
  assert.match(compact, /\.token-speed-legends\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(compact, /\.token-speed-provider\s*\{[^}]*display:\s*none/);
});
