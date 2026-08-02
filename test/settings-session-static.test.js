const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
const settingsJs = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(root, 'src/renderer/settings-window.html'), 'utf8');

test('preload exposes session login channels', () => {
  assert.match(preload, /'session:relogin'/);
  assert.match(preload, /'get:session-state'/);
  assert.match(preload, /'session:changed'/);
});

test('main handles session:relogin by opening the platform login window', () => {
  const handler = main.match(/ipcMain\.on\('session:relogin'[\s\S]*?\n  \}\);/);
  assert.ok(handler);
  assert.match(handler[0], /createSessionWindow\(\)/);
});

test('main exposes get:session-state with login flag and error', () => {
  const handler = main.match(/ipcMain\.handle\('get:session-state'[\s\S]*?\n  \}\);/);
  assert.ok(handler);
  assert.match(handler[0], /loggedIn/);
  assert.match(handler[0], /error/);
});

test('session state is broadcast on capture, expiry and aborted login', () => {
  assert.match(main, /function broadcastSessionState\(/);
  const capture = main.match(/sessionToken = auth\.replace[\s\S]*?startUsageTimer\(\);/);
  assert.ok(capture);
  assert.match(capture[0], /broadcastSessionState\(\)/);
  const expiry = main.match(/会话已过期，请重新登录[\s\S]*?\n    \}/);
  assert.ok(expiry);
  assert.match(expiry[0], /broadcastSessionState\(\)/);
  const closed = main.match(/sessionWindow\.on\('closed'[\s\S]*?\n  \}\);/);
  assert.ok(closed);
  assert.match(closed[0], /broadcastSessionState\(\)/);
});

test('settings window renders a platform login section with a relogin button', () => {
  assert.match(settingsJs, /session:relogin/);
  assert.match(settingsJs, /get:session-state/);
  assert.match(settingsJs, /session:changed/);
  assert.match(settingsJs, /status-dot/);
});

test('settings window shares the main window design tokens', () => {
  assert.match(settingsHtml, /css\/main\.css/);
  assert.match(settingsHtml, /id="app"/);
  assert.doesNotMatch(settingsHtml, /--primary:\s*#74B8FC/);
  assert.doesNotMatch(settingsHtml, /--bg-card:\s*#F8F9FC/);
});

test('settings header reuses the main window titlebar pattern', () => {
  assert.match(settingsHtml, /class="titlebar"/);
  assert.match(settingsHtml, /titlebar-btn/);
});
