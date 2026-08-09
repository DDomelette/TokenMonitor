const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('preload exposes exact diagnostics channel shapes, strips Electron events, and preserves unsubscribe behavior', async (t) => {
  const originalLoad = Module._load;
  const listeners = new Map();
  const sends = [];
  const invokes = [];
  let exposed;
  const ipcRenderer = {
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    send(channel, data) { sends.push({ channel, data }); },
    invoke(channel, ...args) { invokes.push({ channel, args }); return Promise.resolve({ channel, args }); }
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld(name, api) { exposed = { name, api }; } },
        ipcRenderer
      };
    }
    return originalLoad(request, parent, isMain);
  };
  const preloadPath = require.resolve('../src/preload/preload.js');
  delete require.cache[preloadPath];
  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  });

  require(preloadPath);
  assert.equal(exposed.name, 'api');
  const received = [];
  const unsubscribe = exposed.api.on('diagnostics:progress', (...args) => received.push(args));
  const electronEvent = { sender: 'must-not-leak' };
  listeners.get('diagnostics:progress')(electronEvent, { runId: 'run-1' }, 'extra');
  assert.deepEqual(received, [[{ runId: 'run-1' }, 'extra']]);
  unsubscribe();
  assert.equal(listeners.has('diagnostics:progress'), false);

  exposed.api.send('open:diagnostics');
  exposed.api.send('window:close-diagnostics');
  exposed.api.send('diagnostics:progress', { forged: true });
  assert.deepEqual(sends.map((entry) => entry.channel), ['open:diagnostics', 'window:close-diagnostics']);

  await exposed.api.invoke('diagnostics:run');
  await exposed.api.invoke('diagnostics:copy-report', 'run-1');
  await exposed.api.invoke('diagnostics:open-guide', 'app-runtime');
  assert.deepEqual(invokes, [
    { channel: 'diagnostics:run', args: [] },
    { channel: 'diagnostics:copy-report', args: ['run-1'] },
    { channel: 'diagnostics:open-guide', args: ['app-runtime'] }
  ]);

  const noop = exposed.api.on('diagnostics:unknown', () => assert.fail('unknown listener ran'));
  assert.equal(typeof noop, 'function');
  noop();
  exposed.api.send('diagnostics:unknown', 'ignored');
  await assert.rejects(exposed.api.invoke('diagnostics:unknown'), /Invalid channel/);
  assert.equal(listeners.has('diagnostics:unknown'), false);
  assert.equal(sends.some((entry) => entry.channel === 'diagnostics:unknown'), false);
});
