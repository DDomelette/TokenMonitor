const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshStoreModule() {
  const modulePath = require.resolve('../src/main/store');
  delete require.cache[modulePath];
  return require(modulePath);
}

function tempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-bootstrap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('store module is lazy and its facade delegates to the initialized instance', (t) => {
  const store = freshStoreModule();
  assert.equal(typeof store.initialize, 'function');
  assert.equal(typeof store.createStore, 'function');
  assert.equal(typeof store.migrateLegacyKeys, 'function');
  assert.throws(() => store.get('window'), (error) => error && error.code === 'STORE_NOT_INITIALIZED');

  const userDataDir = tempUserData(t);
  const calls = [];
  class FakeStore {
    constructor(options) {
      this.options = options;
      this.store = {
        providers: { deepseek: { apiKey: 'sk-private', sessionToken: 'session-private' } },
        window: { width: 420 }
      };
    }
    get(key) {
      calls.push(['get', key, this]);
      if (key === 'window') return this.store.window;
      return undefined;
    }
    set(key, value) {
      calls.push(['set', key, value, this]);
    }
  }

  const instance = store.initialize({ StoreClass: FakeStore, userDataDir });
  assert.ok(instance instanceof FakeStore);
  assert.equal(store.initialize({ StoreClass: class {}, userDataDir }), instance);
  assert.deepEqual(store.get('window'), { width: 420 });
  store.set('window.width', 500);
  assert.equal(calls[0][2], instance, 'facade should bind instance methods');
  assert.equal(calls[1][3], instance, 'facade should bind instance methods');
  assert.deepEqual(store.sanitizeSettings(store.store), {
    providers: { deepseek: { apiKeySet: true } },
    window: { width: 420 }
  });
});

test('store factory keeps defaults and disables destructive invalid-config clearing', (t) => {
  const store = freshStoreModule();
  const userDataDir = tempUserData(t);
  let options;
  class FakeStore {
    constructor(nextOptions) {
      options = nextOptions;
    }
  }

  store.createStore({ StoreClass: FakeStore, userDataDir });

  assert.equal(options.clearInvalidConfig, false);
  assert.equal(options.cwd, userDataDir);
  assert.equal(options.name, 'config');
  assert.equal(options.defaults.window.width, 420);
  assert.equal(options.defaults.providers.deepseek.apiKey, '');
  assert.match(options.encryptionKey, /^[0-9a-f]{64}$/);
});

test('legacy migration remains available through the lazy facade', () => {
  const store = freshStoreModule();
  const data = {
    sessionToken: 'old-session',
    apiKey: 'old-api-key'
  };
  const fake = {
    get(key) {
      return key.split('.').reduce((value, part) => value && value[part], data);
    },
    set(key, value) {
      const parts = key.split('.');
      let node = data;
      while (parts.length > 1) {
        const part = parts.shift();
        node[part] = node[part] || {};
        node = node[part];
      }
      node[parts[0]] = value;
    },
    delete(key) {
      delete data[key];
    }
  };

  assert.equal(store.migrateLegacyKeys(fake), true);
  assert.equal(data.providers.deepseek.sessionToken, 'old-session');
  assert.equal(data.providers.deepseek.apiKey, 'old-api-key');
  assert.equal(data.sessionToken, undefined);
  assert.equal(data.apiKey, undefined);
});

test('startup coordinator loads the main process only after store initialization succeeds', async () => {
  const { runStoreBootstrap } = require('../src/main/core/startup-recovery');
  const sequence = [];
  const app = {
    getPath(name) {
      assert.equal(name, 'userData');
      sequence.push('getPath');
      return '/safe/user-data';
    },
    quit() {
      sequence.push('quit');
    }
  };
  const storeModule = {
    initialize(options) {
      sequence.push(['initialize', options.userDataDir]);
    }
  };

  const result = await runStoreBootstrap({
    app,
    dialog: {},
    shell: {},
    storeModule,
    loadMain() {
      sequence.push('loadMain');
    },
    logger: { error() { throw new Error('success path must not log errors'); } }
  });

  assert.deepEqual(sequence, [
    'getPath',
    ['initialize', '/safe/user-data'],
    'loadMain'
  ]);
  assert.deepEqual(result, { started: true });
});

test('startup failure shows only safe recovery data, optionally opens the backup, and never loads main', async () => {
  const { runStoreBootstrap } = require('../src/main/core/startup-recovery');
  const backupDir = '/safe/recovery-backups/backup-0123456789abcdef';
  const calls = [];
  const logs = [];
  const app = {
    isQuitting: false,
    getPath() {
      return '/safe/user-data';
    },
    quit() {
      calls.push('quit');
    }
  };
  const unsafe = Object.assign(new Error('sk-api-key session-token stack-secret'), {
    code: 'CONFIG_READ_FAILED',
    causeCode: 'SYNTAX_ERROR',
    backupDir,
    backupStatus: 'complete'
  });

  const result = await runStoreBootstrap({
    app,
    dialog: {
      async showMessageBox(options) {
        calls.push(['dialog', options]);
        return { response: 0 };
      }
    },
    shell: {
      async openPath(target) {
        calls.push(['openPath', target]);
        return '';
      }
    },
    storeModule: {
      initialize() {
        throw unsafe;
      }
    },
    loadMain() {
      calls.push('loadMain');
    },
    logger: {
      error(...args) {
        logs.push(args);
      }
    }
  });

  assert.equal(result.started, false);
  assert.equal(result.code, 'CONFIG_READ_FAILED');
  assert.equal(app.isQuitting, true);
  assert.equal(calls.some((entry) => entry === 'loadMain'), false);
  assert.deepEqual(calls.slice(-2), [['openPath', backupDir], 'quit']);
  const dialogCall = calls.find((entry) => Array.isArray(entry) && entry[0] === 'dialog');
  assert.ok(dialogCall);
  assert.deepEqual(dialogCall[1].buttons, ['打开恢复副本', '退出']);
  const exposed = JSON.stringify({ calls, logs, result });
  assert.doesNotMatch(exposed, /sk-api-key|session-token|stack-secret/);
  assert.match(exposed, /CONFIG_READ_FAILED/);
  assert.match(exposed, /SYNTAX_ERROR/);
});

test('dialog and shell failures remain sanitized and still quit without loading main', async () => {
  const { runStoreBootstrap } = require('../src/main/core/startup-recovery');
  const logs = [];
  let quitCalls = 0;
  let mainLoads = 0;
  const result = await runStoreBootstrap({
    app: {
      isQuitting: false,
      getPath() { return '/safe/user-data'; },
      quit() { quitCalls += 1; }
    },
    dialog: {
      async showMessageBox() {
        throw new Error('dialog-secret');
      }
    },
    shell: {
      async openPath() {
        throw new Error('shell-secret');
      }
    },
    storeModule: {
      initialize() {
        throw new Error('store-secret');
      }
    },
    loadMain() { mainLoads += 1; },
    logger: { error(...args) { logs.push(args); } }
  });

  assert.equal(result.started, false);
  assert.equal(result.code, 'STORE_STARTUP_FAILED');
  assert.equal(quitCalls, 1);
  assert.equal(mainLoads, 0);
  const exposed = JSON.stringify(logs);
  assert.doesNotMatch(exposed, /dialog-secret|shell-secret|store-secret/);
  assert.match(exposed, /STORE_STARTUP_FAILED/);
  assert.match(exposed, /DIALOG_FAILED/);
});

test('package entry and bootstrap source enforce recovery before index loading', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
  const bootstrap = fs.readFileSync(path.resolve(__dirname, '../src/main/bootstrap.js'), 'utf8');
  const storeSource = fs.readFileSync(path.resolve(__dirname, '../src/main/store.js'), 'utf8');

  assert.equal(pkg.main, 'src/main/bootstrap.js');
  assert.match(bootstrap, /app\.whenReady\(\)/);
  assert.match(bootstrap, /runStoreBootstrap/);
  assert.match(bootstrap, /loadMain:\s*\(\)\s*=>\s*require\('\.\/index'\)/);
  assert.doesNotMatch(storeSource, /clearInvalidConfig\s*:\s*true/);
  assert.doesNotMatch(storeSource, /^const\s+store\s*=\s*new\s+Store/m);
});
