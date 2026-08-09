const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { detectProxyPort, DEFAULT_CANDIDATE_PORTS } = require('../src/main/core/proxy-detect');

function fakeNet(listeningPorts) {
  return {
    connect({ port }) {
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      process.nextTick(() => {
        if (listeningPorts.includes(port)) socket.emit('connect');
        else socket.emit('error', new Error('ECONNREFUSED'));
      });
      return socket;
    }
  };
}

test('detectProxyPort returns the first listening candidate port', async () => {
  const port = await detectProxyPort({ ports: [7890, 7897, 1080], net: fakeNet([7897]) });
  assert.equal(port, 7897);
});

test('detectProxyPort returns null when no candidate port listens', async () => {
  const port = await detectProxyPort({ ports: [1, 2], net: fakeNet([]) });
  assert.equal(port, null);
});

test('candidate ports cover common local proxy defaults (Clash/Clash Verge/v2rayN)', () => {
  assert.ok(DEFAULT_CANDIDATE_PORTS.includes(7890));
  assert.ok(DEFAULT_CANDIDATE_PORTS.includes(7897));
  assert.ok(DEFAULT_CANDIDATE_PORTS.includes(10809));
});

test('wiring: ipc handler + preload whitelist + last-custom persistence + settings prefill', () => {
  const root = path.resolve(__dirname, '..');
  const ipc = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
  const settingsWrite = fs.readFileSync(path.join(root, 'src/main/core/settings-write.js'), 'utf8');
  const settingsJs = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');
  assert.match(ipc, /ipcMain\.handle\('detect:proxy-port'/);
  assert.match(preload, /'detect:proxy-port'/);
  // 自定义代理保存成功时顺手记下"上次使用的地址",供下次预填
  assert.match(settingsWrite, /proxyUrlLastCustom/);
  // 自定义模式且输入为空时:优先探测本机监听端口,否则回填上次地址
  assert.match(settingsJs, /detect:proxy-port/);
  assert.match(settingsJs, /proxyUrlLastCustom/);
  assert.match(settingsJs, /prefillProxyUrl/);
});
