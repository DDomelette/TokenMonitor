const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

test('ipc registers mcp connection info and rotate handlers', () => {
  const ipc = read('src/main/ipc.js');
  assert.match(ipc, /ipcMain\.handle\('mcp:getConnectionInfo'/);
  assert.match(ipc, /ipcMain\.handle\('mcp:rotateToken'/);
});

test('preload whitelists the two mcp invoke channels', () => {
  const preload = read('src/preload/preload.js');
  assert.match(preload, /'mcp:getConnectionInfo'/);
  assert.match(preload, /'mcp:rotateToken'/);
});

test('settings definitions declare mcp.enabled toggle and mcpServer info block', () => {
  const defs = read('src/renderer/js/settings-definitions.js');
  assert.match(defs, /key: 'mcp\.enabled', type: 'toggle'/);
  assert.match(defs, /type: 'mcpServer'/);
});

test('settings window renders mcpServer block with copy and rotate actions', () => {
  const win = read('src/renderer/js/settings-window.js');
  assert.match(win, /mcpServer/);
  assert.match(win, /mcp:getConnectionInfo/);
  assert.match(win, /mcp:rotateToken/);
  assert.match(win, /clipboard/);
});

test('tray menu offers copying MCP connection info', () => {
  const index = read('src/main/index.js');
  assert.match(index, /复制 MCP 连接信息/);
  assert.match(index, /clipboard/);
});
