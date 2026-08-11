'use strict';

// Windows Accent 亚克力背景:经 koffi FFI 调用 user32/dwmapi/gdi32,
// 为无边框非透明窗口提供"失焦不褪色"的亚克力背景。
//
// 背景:Electron 的 backgroundMaterial(DWMWA_SYSTEMBACKDROP_TYPE)在窗口
// 失焦时按 Windows 设计退化为不透明纯色;而 Accent 策略
// (SetWindowCompositionAttribute + ACCENT_ENABLE_ACRYLICBLURBEHIND)
// 不随焦点状态切换。该 API 未公开,自 Windows 10 1709 起稳定可用。
// 所有调用 lazy 且 best-effort:失败时由调用方回退 backgroundMaterial。

const WCA_ACCENT_POLICY = 19;
const ACCENT_DISABLED = 0;
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;
const DWM_BB_ENABLE = 0x1;
const DWM_BB_BLURREGION = 0x2;
const DWM_BB_TRANSITIONONMAXIMIZED = 0x4;

// 主题 tint。注意 GradientColor 是 ABGR 字节序(高字节 alpha,其后 B/G/R),
// 不是 ARGB——灰色无所谓,彩色写反会蓝红颠倒
const ACCENT_TINTS = {
  'acrylic-light': 0x14ffffff, // 白,alpha 0.08
  'acrylic-dark': 0x261c1614 // rgba(20,22,28,0.15) 的 ABGR
};

let accentApi;

function isAcrylicTheme(theme) {
  return theme === 'acrylic-light' || theme === 'acrylic-dark';
}

function tintForTheme(theme) {
  return Object.prototype.hasOwnProperty.call(ACCENT_TINTS, theme) ? ACCENT_TINTS[theme] : null;
}

function hwndOf(win) {
  const buffer = win.getNativeWindowHandle();
  return buffer.length >= 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE());
}

function createAccentApi(koffi) {
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const gdi32 = koffi.load('gdi32.dll');

  const ACCENT_POLICY = koffi.struct('DSM_ACCENT_POLICY', {
    AccentState: 'int32_t',
    AccentFlags: 'int32_t',
    GradientColor: 'uint32_t',
    AnimationId: 'int32_t'
  });
  koffi.struct('DSM_WCA_DATA', {
    Attrib: 'uint32_t',
    pvData: 'void *',
    cbData: 'size_t'
  });
  koffi.struct('DSM_DWM_BLURBEHIND', {
    dwFlags: 'uint32_t',
    fEnable: 'int32_t',
    hRgnBlur: 'void *',
    fTransitionOnMaximized: 'int32_t'
  });
  koffi.struct('DSM_MARGINS', {
    cxLeftWidth: 'int32_t',
    cxRightWidth: 'int32_t',
    cyTopHeight: 'int32_t',
    cyBottomHeight: 'int32_t'
  });

  const SetWindowCompositionAttribute = user32.func(
    'bool SetWindowCompositionAttribute(uintptr_t hwnd, const DSM_WCA_DATA *data)'
  );
  const DwmEnableBlurBehindWindow = dwmapi.func(
    'long DwmEnableBlurBehindWindow(uintptr_t hwnd, const DSM_DWM_BLURBEHIND *blurBehind)'
  );
  const DwmExtendFrameIntoClientArea = dwmapi.func(
    'long DwmExtendFrameIntoClientArea(uintptr_t hwnd, const DSM_MARGINS *margins)'
  );
  const CreateRectRgn = gdi32.func('void *CreateRectRgn(int left, int top, int right, int bottom)');
  const DeleteObject = gdi32.func('bool DeleteObject(void *object)');

  function setAccentState(hwnd, state, argb) {
    const accent = {
      AccentState: state,
      AccentFlags: 0,
      GradientColor: argb >>> 0,
      AnimationId: 0
    };
    const data = {
      Attrib: WCA_ACCENT_POLICY,
      pvData: koffi.as(accent, 'DSM_ACCENT_POLICY *'),
      cbData: koffi.sizeof(ACCENT_POLICY)
    };
    return Boolean(SetWindowCompositionAttribute(hwnd, data));
  }

  return {
    enable(hwnd, argb) {
      const region = CreateRectRgn(0, 0, -1, -1);
      if (!region) return false;
      try {
        const blurBehind = {
          dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION | DWM_BB_TRANSITIONONMAXIMIZED,
          fEnable: 1,
          hRgnBlur: region,
          fTransitionOnMaximized: 1
        };
        if (DwmEnableBlurBehindWindow(hwnd, blurBehind) < 0) return false;
        if (
          DwmExtendFrameIntoClientArea(hwnd, {
            cxLeftWidth: -1,
            cxRightWidth: -1,
            cyTopHeight: -1,
            cyBottomHeight: -1
          }) < 0
        ) {
          return false;
        }
        return setAccentState(hwnd, ACCENT_ENABLE_ACRYLICBLURBEHIND, argb);
      } finally {
        DeleteObject(region);
      }
    },
    disable(hwnd) {
      DwmEnableBlurBehindWindow(hwnd, {
        dwFlags: DWM_BB_ENABLE,
        fEnable: 0,
        hRgnBlur: null,
        fTransitionOnMaximized: 0
      });
      return setAccentState(hwnd, ACCENT_DISABLED, 0);
    }
  };
}

function loadAccentApi() {
  if (accentApi !== undefined) return accentApi;
  try {
    accentApi = createAccentApi(require('koffi'));
  } catch (_) {
    accentApi = null;
  }
  return accentApi;
}

function isAccentSupported() {
  return process.platform === 'win32' && loadAccentApi() !== null;
}

function resolveApi(options) {
  return options.api === undefined ? loadAccentApi() : options.api;
}

function canTouch(win, options) {
  const platform = options.platform || process.platform;
  return platform === 'win32' && Boolean(win) && !(win.isDestroyed && win.isDestroyed());
}

// 为窗口启用/更新 Accent 亚克力;argb 省略时用暗调 tint
function applyAccent(win, options = {}) {
  if (!canTouch(win, options)) return false;
  const api = resolveApi(options);
  if (!api) return false;
  const argb = options.argb === undefined ? ACCENT_TINTS['acrylic-dark'] : options.argb;
  try {
    return api.enable(hwndOf(win), argb >>> 0) === true;
  } catch (_) {
    return false;
  }
}

// 关闭 Accent,恢复普通窗口背景(切回非亚克力主题时调用)
function clearAccent(win, options = {}) {
  if (!canTouch(win, options)) return false;
  const api = resolveApi(options);
  if (!api) return false;
  try {
    return api.disable(hwndOf(win)) === true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  ACCENT_TINTS,
  isAcrylicTheme,
  tintForTheme,
  isAccentSupported,
  applyAccent,
  clearAccent,
  createAccentApi,
  loadAccentApi
};
