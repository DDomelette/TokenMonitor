const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectWindowsCapabilities,
  createWindowsChecks
} = require('../src/main/core/diagnostics/checks/windows');

function fakeKoffi(calls) {
  const library = (name) => ({
    func(signature) {
      calls.push(['func', name, signature]);
      if (signature.includes('DwmIsCompositionEnabled')) {
        return (enabled) => {
          calls.push(['call', 'DwmIsCompositionEnabled']);
          enabled[0] = 1;
          return 0;
        };
      }
      if (signature.includes('SetWindowCompositionAttribute')) {
        return () => {
          calls.push(['call', 'SetWindowCompositionAttribute']);
          return true;
        };
      }
      return () => 0;
    }
  });
  return {
    load(name) {
      calls.push(['load', name]);
      return library(name);
    },
    struct() { return {}; },
    as(value) { return value; },
    sizeof() { return 16; }
  };
}

function fakeWindow(calls, options = {}) {
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(0x1122334455667788n);
  return {
    getNativeWindowHandle() {
      calls.push('handle');
      return handle;
    },
    setBackgroundMaterial(material) {
      calls.push(['material', material]);
      if (options.materialError) throw new Error('material failure');
    },
    destroy() {
      calls.push('destroy');
      if (options.destroyError) throw new Error('destroy failure');
    }
  };
}

function windowsDependencies(overrides = {}) {
  const calls = [];
  const window = fakeWindow(calls, overrides.windowOptions);
  const dependencies = Object.assign({
    platform: 'win32',
    release: '10.0.19045',
    koffi: fakeKoffi(calls),
    BrowserWindow: function BrowserWindow(options) {
      calls.push(['window', options]);
      return window;
    },
    createAccentApi(koffi) {
      calls.push(['createAccentApi', koffi !== undefined]);
      return { enable() { return true; }, disable() { return true; } };
    },
    applyAccent(win, options) {
      calls.push(['apply', win === window, options.platform]);
      return true;
    },
    clearAccent(win, options) {
      calls.push(['clear', win === window, options.platform]);
      return true;
    },
    app: {
      getGPUFeatureStatus() {
        calls.push('gpuFeatures');
        return { gpu_compositing: 'enabled' };
      },
      async getGPUInfo(level) {
        calls.push(['gpuInfo', level]);
        return {
          auxAttributes: { amdSwitchable: 1, optimus: 0 },
          gpuDevice: [{ driver_version: 'must-not-leak' }]
        };
      }
    }
  }, overrides);
  return { calls, dependencies };
}

function byId(checks, id) {
  return checks.find((check) => check.id === id);
}

test('collectWindowsCapabilities refreshes per run and safely redacts GPU details', async () => {
  const { calls, dependencies } = windowsDependencies();
  const firstPromise = collectWindowsCapabilities(dependencies);
  const secondPromise = collectWindowsCapabilities(dependencies);
  const snapshot = await firstPromise;
  const repeated = await secondPromise;

  assert.notEqual(firstPromise, secondPromise);
  assert.notEqual(snapshot, repeated);
  assert.equal(snapshot.koffiLoaded, true);
  assert.deepEqual(snapshot.libraries, { user32: true, dwmapi: true, gdi32: true });
  assert.equal(snapshot.ffiBound, true);
  assert.equal(snapshot.nativeHandleValid, true);
  assert.equal(snapshot.accentApplied, true);
  assert.equal(snapshot.electronFallbackAvailable, true);
  assert.equal(snapshot.dwmCompositionEnabled, true);
  assert.deepEqual(snapshot.gpu, {
    features: { gpu_compositing: 'enabled' },
    auxAttributes: { amdSwitchable: true, optimus: false }
  });
  assert.equal(JSON.stringify(snapshot).includes('must-not-leak'), false);
  assert.equal(calls.filter((entry) => entry === 'destroy').length, 2);
  assert.equal(calls.filter((entry) => Array.isArray(entry) && entry[0] === 'clear').length, 2);
  assert.ok(calls.some((entry) => Array.isArray(entry) && entry[0] === 'func' && entry[2].includes('DwmIsCompositionEnabled')));
  assert.ok(calls.some((entry) => Array.isArray(entry) && entry[0] === 'func' && entry[2].includes('SetWindowCompositionAttribute')));
  assert.ok(calls.indexOf('destroy') > calls.findIndex((entry) => Array.isArray(entry) && entry[0] === 'clear'));
});

test('Windows capability collection clears and destroys its hidden window after apply, verification, clear, and destroy failures', async () => {
  const cases = [
    ['apply', { applyAccent() { throw new Error('apply failure'); } }],
    ['verify', { verifyAccent() { throw new Error('verify failure'); } }],
    ['material', { windowOptions: { materialError: true } }],
    ['clear', { clearAccent() { throw new Error('clear failure'); } }],
    ['destroy', { windowOptions: { destroyError: true } }]
  ];

  for (const [name, overrides] of cases) {
    const { calls, dependencies } = windowsDependencies(overrides);
    if (name === 'clear') {
      dependencies.clearAccent = () => {
        calls.push(['clear', true, 'win32']);
        throw new Error('clear failure');
      };
    }
    const snapshot = await collectWindowsCapabilities(dependencies);
    assert.equal(snapshot.nativeHandleValid, true, `${name} retains its safe handle inspection`);
    assert.equal(calls.filter((entry) => entry === 'destroy').length, 1, `${name} destroys once`);
    assert.ok(calls.some((entry) => Array.isArray(entry) && entry[0] === 'clear'), `${name} attempts cleanup`);
    assert.equal(calls.indexOf('destroy') > calls.findIndex((entry) => Array.isArray(entry) && entry[0] === 'clear'), true, `${name} clears before destruction`);
  }
});

test('non-Windows checks are skipped without loading Windows or Electron dependencies', async () => {
  const touches = [];
  const dependencies = {
    platform: 'linux',
    koffi: { load() { touches.push('koffi'); throw new Error('must not load'); } },
    BrowserWindow() { touches.push('window'); throw new Error('must not create'); },
    app: {
      getGPUFeatureStatus() { touches.push('gpu features'); throw new Error('must not read'); },
      getGPUInfo() { touches.push('gpu info'); throw new Error('must not read'); }
    }
  };
  const snapshot = await collectWindowsCapabilities(dependencies);
  const checks = createWindowsChecks(dependencies);
  const context = { runScope: { windows: Promise.resolve(snapshot) } };
  const results = await Promise.all(checks.map((check) => check.run(context)));

  assert.equal(snapshot.supported, false);
  assert.deepEqual(touches, []);
  assert.equal(results.every((result) => result.status === 'skipped'), true);
});

test('Windows diagnostic checks project a shared snapshot with stable contracts and failure guides', async () => {
  const { dependencies } = windowsDependencies({
    applyAccent() { return false; },
    app: {
      getGPUFeatureStatus() { throw Object.assign(new Error('gpu failure'), { code: 'GPU_FAILURE' }); },
      async getGPUInfo() { throw new Error('not reached'); }
    }
  });
  const checks = createWindowsChecks(dependencies);
  const context = { runScope: { windows: collectWindowsCapabilities(dependencies) } };
  const results = new Map(await Promise.all(checks.map(async (check) => [check.id, await check.run(context)])));

  assert.deepEqual(checks.map((check) => [check.id, check.phase, check.timeoutMs, check.guideId]), [
    ['windows.platform-build', 'windows', 3000, 'windows-acrylic'],
    ['windows.dwm-composition', 'windows', 3000, 'windows-acrylic'],
    ['windows.koffi-runtime', 'windows', 3000, 'windows-acrylic'],
    ['windows.native-libraries', 'windows', 3000, 'windows-acrylic'],
    ['windows.ffi-bindings', 'windows', 3000, 'windows-acrylic'],
    ['windows.native-handle', 'windows', 3000, 'windows-acrylic'],
    ['windows.acrylic-accent', 'windows', 3000, 'windows-acrylic'],
    ['windows.electron-acrylic', 'windows', 3000, 'windows-acrylic'],
    ['windows.gpu', 'windows', 3000, 'windows-gpu'],
    ['windows.transparency-settings', 'windows', 3000, 'windows-acrylic']
  ]);
  assert.equal(results.get('windows.acrylic-accent').status, 'fail');
  assert.equal(results.get('windows.acrylic-accent').errorCode, 'WINDOWS_ACRYLIC');
  assert.equal(results.get('windows.gpu').status, 'fail');
  assert.equal(results.get('windows.gpu').errorCode, 'WINDOWS_GPU');
  assert.deepEqual(results.get('windows.transparency-settings'), {
    status: 'skipped',
    summary: '无法通过可靠的无副作用接口确认'
  });
});

test('Windows build gating uses an injected build first and fails closed for unknown or pre-Acrylic versions', async () => {
  const cases = [
    ['injected pre-Acrylic build', { getWindowsBuild: () => 16298 }, 'fail'],
    ['injected minimum Acrylic build', { getWindowsBuild: () => 16299 }, 'pass'],
    ['release pre-Acrylic build', { release: '10.0.16298' }, 'fail'],
    ['release minimum Acrylic build', { release: '10.0.16299' }, 'pass'],
    ['injected unknown build', { getWindowsBuild: () => 'unknown' }, 'fail'],
    ['injected build error', { getWindowsBuild() { throw new Error('unavailable'); } }, 'fail'],
    ['unknown release', { release: 'unknown' }, 'fail']
  ];

  for (const [name, overrides, expected] of cases) {
    const { dependencies } = windowsDependencies(overrides);
    const checks = createWindowsChecks(dependencies);
    const result = await byId(checks, 'windows.platform-build').run({
      runScope: { windows: collectWindowsCapabilities(dependencies) }
    });
    assert.equal(result.status, expected, name);
  }

  const fromOs = windowsDependencies({ release: undefined, os: { release: () => '10.0.16299' } });
  const fromOsResult = await byId(createWindowsChecks(fromOs.dependencies), 'windows.platform-build').run({
    runScope: { windows: collectWindowsCapabilities(fromOs.dependencies) }
  });
  assert.equal(fromOsResult.status, 'pass');
});

test('unsupported and unknown builds never touch native dependencies while GPU remains independently readable', async () => {
  const cases = [
    ['pre-Acrylic', () => 16298, '10.0.19045'],
    ['unknown injected', () => 'unknown', '10.0.19045'],
    ['throwing injected', () => { throw new Error('build unavailable'); }, '10.0.19045'],
    ['unknown release', undefined, 'unknown']
  ];
  for (const [name, getWindowsBuild, release] of cases) {
    let nativeTouches = 0;
    let gpuTouches = 0;
    const dependencies = {
      platform: 'win32',
      release,
      getWindowsBuild,
      app: {
        getGPUFeatureStatus() { gpuTouches += 1; return { gpu_compositing: 'enabled' }; },
        async getGPUInfo() { gpuTouches += 1; return { auxAttributes: {} }; }
      }
    };
    for (const key of ['koffi', 'BrowserWindow', 'createAccentApi', 'applyAccent', 'clearAccent']) {
      Object.defineProperty(dependencies, key, {
        configurable: true,
        get() {
          nativeTouches += 1;
          throw new Error(`${key} must not be touched`);
        }
      });
    }

    const snapshot = await collectWindowsCapabilities(dependencies);
    assert.equal(snapshot.supported, true, name);
    assert.equal(snapshot.platformBuildSupported, false, name);
    assert.equal(nativeTouches, 0, name);
    assert.equal(gpuTouches, 2, name);
    assert.equal(snapshot.gpuAvailable, true, name);
    const context = { runScope: { windows: Promise.resolve(snapshot) } };
    const results = await Promise.all(createWindowsChecks(dependencies).map((check) => check.run(context)));
    assert.equal(results.find((result, index) => createWindowsChecks(dependencies)[index].id === 'windows.gpu').status, 'pass', name);
    assert.equal(results.filter((_, index) => createWindowsChecks(dependencies)[index].id !== 'windows.gpu')
      .every((result) => result.status === 'fail' || result.status === 'skipped'), true, name);
  }
});

test('default, null, and primitive capability inputs return independent safe unsupported snapshots', async () => {
  const first = collectWindowsCapabilities();
  const second = collectWindowsCapabilities();
  const nullInput = collectWindowsCapabilities(null);
  const primitiveInput = collectWindowsCapabilities('not-dependencies');

  assert.notEqual(first, second);
  assert.notEqual(first, nullInput);
  assert.notEqual(first, primitiveInput);
  const snapshots = await Promise.all([first, nullInput, primitiveInput]);
  assert.equal(snapshots.every((snapshot) => snapshot.supported === false), true);
  assert.notEqual(snapshots[0], snapshots[1]);
});
