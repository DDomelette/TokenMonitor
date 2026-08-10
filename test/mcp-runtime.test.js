const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startMCP } = require('../src/main/mcp');

function makeStore(seed) {
  const data = Object.assign({}, seed);
  return { data, get(k) { return data[k]; }, set(k, v) { data[k] = v; } };
}
const fakeScheduler = {
  getSnapshot: () => [],
  getState: () => null
};

// 固定端口在 Windows 上可能落在 Hyper-V 保留段(EACCES),测试先探测空闲端口
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test('disabled by setting: start() is a no-op, connection info reports disabled', async () => {
  const rt = startMCP({ store: makeStore({ 'mcp.enabled': false }), scheduler: fakeScheduler });
  await rt.start();
  assert.equal(rt.isRunning(), false);
  const info = rt.getConnectionInfo();
  assert.equal(info.enabled, false);
  assert.equal(info.running, false);
  assert.equal(info.url, null);
});

test('enabled by default: start() listens, token persisted, stop() releases', async () => {
  const store = makeStore({});
  const port = await freePort();
  const rt = startMCP({ store, scheduler: fakeScheduler, basePort: port, maxPort: port + 2 });
  await rt.start();
  assert.equal(rt.isRunning(), true);
  const info = rt.getConnectionInfo();
  assert.equal(info.enabled, true);
  assert.equal(info.running, true);
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.match(info.token, /^[0-9a-f]{48}$/);
  assert.equal(store.get('mcp.token'), info.token);
  await rt.stop();
  assert.equal(rt.isRunning(), false);
});

test('rotateToken changes token and keeps service running with it', async (t) => {
  const store = makeStore({});
  const port = await freePort();
  const rt = startMCP({ store, scheduler: fakeScheduler, basePort: port, maxPort: port + 2 });
  await rt.start();
  const before = rt.getConnectionInfo();
  const next = await rt.rotateToken();
  assert.notEqual(next, before.token);
  assert.equal(rt.isRunning(), true);
  const after = rt.getConnectionInfo();
  assert.equal(after.token, next);
  assert.equal(after.port, before.port, '同端口重启(测试环境无占用)');
  await rt.stop();
});
