'use strict';

const { createAccentApi, applyAccent, clearAccent } = require('../../../windows-backdrop');

const TIMEOUT_MS = 3000;
const ACRYLIC_GUIDE = 'windows-acrylic';
const GPU_GUIDE = 'windows-gpu';
const snapshots = new WeakMap();
const defaultDependencies = {};

function definition(id, title, guideId, run) {
  return { id, group: 'Windows', title, guideId, phase: 'windows', timeoutMs: TIMEOUT_MS, run };
}

function normalizeDependencies(dependencies) {
  return dependencies && typeof dependencies === 'object' ? dependencies : defaultDependencies;
}

function unsupportedSnapshot() {
  return { supported: false };
}

function resolveKoffi(dependencies) {
  if (dependencies.koffi) return dependencies.koffi;
  return require('koffi');
}

function resolveElectron(dependencies, name) {
  if (dependencies[name]) return dependencies[name];
  return require('electron')[name];
}

function loadLibrary(koffi, name) {
  try {
    return { library: koffi.load(name), loaded: true };
  } catch (_) {
    return { library: null, loaded: false };
  }
}

function readDwmComposition(dwmapi) {
  try {
    const DwmIsCompositionEnabled = dwmapi.func('long DwmIsCompositionEnabled(int *enabled)');
    const enabled = Buffer.alloc(4);
    const result = DwmIsCompositionEnabled(enabled);
    return { bound: true, enabled: result >= 0 && enabled.readInt32LE(0) !== 0 };
  } catch (_) {
    return { bound: false, enabled: false };
  }
}

function bindAccentEntry(user32) {
  try {
    user32.func('bool SetWindowCompositionAttribute(uintptr_t hwnd, const void *data)');
    return true;
  } catch (_) {
    return false;
  }
}

function safeGpuSnapshot(app) {
  return (async () => {
    try {
      const gpuFeatures = app.getGPUFeatureStatus();
      const gpuBasic = await app.getGPUInfo('basic');
      return {
        available: true,
        gpu: {
          features: gpuFeatures,
          auxAttributes: gpuBasic && gpuBasic.auxAttributes
            ? {
                amdSwitchable: !!gpuBasic.auxAttributes.amdSwitchable,
                optimus: !!gpuBasic.auxAttributes.optimus
              }
            : {}
        }
      };
    } catch (_) {
      return { available: false, gpu: { features: {}, auxAttributes: {} } };
    }
  })();
}

function validNativeHandle(window) {
  try {
    const handle = window.getNativeWindowHandle();
    return Buffer.isBuffer(handle) && handle.length >= 4 && handle.some((byte) => byte !== 0);
  } catch (_) {
    return false;
  }
}

function parseWindowsBuild(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value !== 'string') return null;
  const segments = value.trim().split('.');
  if (!segments.length || !segments.every((segment) => /^\d+$/.test(segment))) return null;
  const build = Number(segments[segments.length - 1]);
  return Number.isSafeInteger(build) ? build : null;
}

function windowsBuildSupported(dependencies) {
  try {
    const version = typeof dependencies.getWindowsBuild === 'function'
      ? dependencies.getWindowsBuild()
      : typeof dependencies.release === 'string'
        ? dependencies.release
        : (dependencies.os || require('node:os')).release();
    const build = parseWindowsBuild(version);
    return build !== null && build >= 16299;
  } catch (_) {
    return false;
  }
}

async function createSnapshot(dependencies) {
  if (dependencies.platform !== 'win32') return unsupportedSnapshot();

  const snapshot = {
    supported: true,
    platformBuildSupported: windowsBuildSupported(dependencies),
    koffiLoaded: false,
    libraries: { user32: false, dwmapi: false, gdi32: false },
    ffiBound: false,
    dwmCompositionEnabled: false,
    nativeHandleValid: false,
    accentApplied: false,
    electronFallbackAvailable: false,
    gpuAvailable: false,
    gpu: { features: {}, auxAttributes: {} }
  };
  let koffi;
  try {
    koffi = resolveKoffi(dependencies);
    snapshot.koffiLoaded = true;
  } catch (_) {
    return snapshot;
  }

  const user32 = loadLibrary(koffi, 'user32.dll');
  const dwmapi = loadLibrary(koffi, 'dwmapi.dll');
  const gdi32 = loadLibrary(koffi, 'gdi32.dll');
  snapshot.libraries = {
    user32: user32.loaded,
    dwmapi: dwmapi.loaded,
    gdi32: gdi32.loaded
  };

  const composition = dwmapi.library ? readDwmComposition(dwmapi.library) : { bound: false, enabled: false };
  const accentEntryBound = user32.library ? bindAccentEntry(user32.library) : false;
  snapshot.dwmCompositionEnabled = composition.enabled;

  let api = null;
  if (snapshot.libraries.user32 && snapshot.libraries.dwmapi && snapshot.libraries.gdi32) {
    try {
      api = (dependencies.createAccentApi || createAccentApi)(koffi);
    } catch (_) {
      api = null;
    }
  }
  snapshot.ffiBound = composition.bound && accentEntryBound && Boolean(api);

  let window;
  try {
    const BrowserWindow = resolveElectron(dependencies, 'BrowserWindow');
    window = new BrowserWindow({ show: false, width: 1, height: 1, frame: false });
    snapshot.nativeHandleValid = validNativeHandle(window);
    if (snapshot.nativeHandleValid && api) {
      try {
        snapshot.accentApplied = (dependencies.applyAccent || applyAccent)(window, { api, platform: 'win32' }) === true;
        if (snapshot.accentApplied && typeof dependencies.verifyAccent === 'function') dependencies.verifyAccent(window);
      } catch (_) {
        snapshot.accentApplied = false;
      }
    }
    try {
      window.setBackgroundMaterial('acrylic');
      snapshot.electronFallbackAvailable = true;
    } catch (_) {
      snapshot.electronFallbackAvailable = false;
    }
  } catch (_) {
    snapshot.nativeHandleValid = false;
  } finally {
    if (window) {
      try {
        (dependencies.clearAccent || clearAccent)(window, { api, platform: 'win32' });
      } catch (_) {
        // Clearing is best-effort, but destroying the temporary window is mandatory.
      } finally {
        try {
          window.destroy();
        } catch (_) {
          // A failed destroy cannot be retried safely; the window is never reused.
        }
      }
    }
  }

  try {
    const app = resolveElectron(dependencies, 'app');
    const gpu = await safeGpuSnapshot(app);
    snapshot.gpuAvailable = gpu.available;
    snapshot.gpu = gpu.gpu;
  } catch (_) {
    // Electron is unavailable outside the main process; leave only safe empty metadata.
  }
  return snapshot;
}

function collectWindowsCapabilities(dependencies) {
  const key = normalizeDependencies(dependencies);
  if (!snapshots.has(key)) {
    snapshots.set(key, Promise.resolve().then(() => createSnapshot(key)).catch(() => unsupportedSnapshot()));
  }
  return snapshots.get(key);
}

function skipped() {
  return { status: 'skipped', summary: 'Windows-only check' };
}

function capabilityResult(snapshot, value, summary, errorCode, metadata) {
  if (!snapshot.supported) return skipped();
  return value
    ? { status: 'pass', summary, metadata }
    : { status: 'fail', summary: `${summary} is unavailable`, errorCode, metadata };
}

function createWindowsChecks(dependencies = {}) {
  const snapshot = () => collectWindowsCapabilities(dependencies);
  return [
    definition('windows.platform-build', 'Windows platform build', ACRYLIC_GUIDE, async () => {
      const state = await snapshot();
      return capabilityResult(state, state.platformBuildSupported, 'Windows build supports acrylic', 'WINDOWS_ACRYLIC');
    }),
    definition('windows.dwm-composition', 'Desktop Window Manager composition', ACRYLIC_GUIDE, async () => {
      const state = await snapshot();
      return capabilityResult(state, state.dwmCompositionEnabled, 'DWM composition is enabled', 'WINDOWS_ACRYLIC');
    }),
    definition('windows.koffi-runtime', 'Koffi runtime', ACRYLIC_GUIDE, async () => {
      const state = await snapshot();
      return capabilityResult(state, state.koffiLoaded, 'Koffi runtime is available', 'WINDOWS_ACRYLIC');
    }),
    definition('windows.native-libraries', 'Windows native libraries', ACRYLIC_GUIDE, async () => {
      const state = await snapshot();
      return capabilityResult(state, Object.values(state.libraries || {}).every(Boolean), 'Native libraries are available', 'WINDOWS_ACRYLIC', { libraries: state.libraries });
    }),
    definition('windows.ffi-bindings', 'Windows FFI bindings', ACRYLIC_GUIDE, async () => {
      const state = await snapshot();
      return capabilityResult(state, state.ffiBound, 'Windows FFI bindings are available', 'WINDOWS_ACRYLIC');
    }),
    definition('windows.native-handle', 'Hidden window native handle', ACRYLIC_GUIDE, async () => {
      const state = await snapshot();
      return capabilityResult(state, state.nativeHandleValid, 'Hidden window native handle is valid', 'WINDOWS_ACRYLIC');
    }),
    definition('windows.acrylic-accent', 'Native Acrylic accent', ACRYLIC_GUIDE, async () => {
      const state = await snapshot();
      return capabilityResult(state, state.accentApplied, 'Native Acrylic accent is available', 'WINDOWS_ACRYLIC');
    }),
    definition('windows.electron-acrylic', 'Electron Acrylic fallback', ACRYLIC_GUIDE, async () => {
      const state = await snapshot();
      return capabilityResult(state, state.electronFallbackAvailable, 'Electron Acrylic fallback is available', 'WINDOWS_ACRYLIC');
    }),
    definition('windows.gpu', 'GPU capabilities', GPU_GUIDE, async () => {
      const state = await snapshot();
      return capabilityResult(state, state.gpuAvailable, 'GPU capability information is available', 'WINDOWS_GPU', state.gpu);
    }),
    definition('windows.transparency-settings', 'Transparency settings', ACRYLIC_GUIDE, async () => {
      const state = await snapshot();
      if (!state.supported) return skipped();
      return { status: 'skipped', summary: '无法通过可靠的无副作用接口确认' };
    })
  ];
}

module.exports = { collectWindowsCapabilities, createWindowsChecks };
