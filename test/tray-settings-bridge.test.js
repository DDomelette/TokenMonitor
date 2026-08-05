const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadBridge() {
  return import('../renderer/src/settings-bridge.js');
}

test('tray settings bridge forwards the preload event to the existing main-process channel', async () => {
  const { installSettingsOpenBridge } = await loadBridge();
  let subscribedChannel = null;
  let handler = null;
  let unsubscribeCalls = 0;
  const sends = [];
  const unsubscribe = () => { unsubscribeCalls += 1; };

  const cleanup = installSettingsOpenBridge(
    (channel, callback) => {
      subscribedChannel = channel;
      handler = callback;
      return unsubscribe;
    },
    (channel, payload) => sends.push({ channel, payload })
  );

  assert.equal(subscribedChannel, 'open:settings');
  assert.equal(typeof handler, 'function');
  assert.deepEqual(sends, []);
  assert.equal(cleanup, unsubscribe);

  handler();
  assert.deepEqual(sends, [{ channel: 'open:settings', payload: undefined }]);

  cleanup();
  assert.equal(unsubscribeCalls, 1);
});

test('App installs the tray settings bridge once and returns its cleanup function', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/App.jsx'),
    'utf8'
  );

  const apiImport = /import \{([^}]*)\} from '\.\/api\.js';/.exec(source);
  assert.ok(apiImport, 'App must import the renderer API');
  assert.match(apiImport[1], /\bon\b/);
  assert.match(apiImport[1], /\bsend\b/);
  assert.match(source, /import \{ installSettingsOpenBridge \} from '\.\/settings-bridge\.js';/);
  assert.match(
    source,
    /useEffect\(\(\) => installSettingsOpenBridge\(on, send\), \[\]\);/
  );
});
