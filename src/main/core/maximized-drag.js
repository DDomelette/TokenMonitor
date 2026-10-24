'use strict';

function validPoint(point) {
  return point && Number.isFinite(point.screenX) && Number.isFinite(point.screenY);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Windows 无边框窗口的系统拖拽区域不会可靠地执行"最大化下拉还原"。
// 该状态机只在最大化拖拽手势中接管:恢复正常尺寸,保持鼠标在标题栏的
// 相对位置,随后按屏幕坐标移动;普通窗口仍使用原生 app-region 拖拽与 Aero Snap。
function createMaximizedDrag(options = {}) {
  const defer = options.defer || ((callback) => setTimeout(callback, 0));
  let active = null;

  function owns(win) {
    return Boolean(active && win && active.win === win && !win.isDestroyed());
  }

  function apply(session) {
    if (session.cancelled || session.win.isDestroyed()) return;
    session.win.setBounds({
      x: Math.round(session.point.screenX - session.offsetX),
      y: Math.round(session.point.screenY - session.offsetY),
      width: session.width,
      height: session.height
    }, false);
  }

  return {
    start(win, point) {
      if (!win || win.isDestroyed() || !validPoint(point) || !win.isMaximized()) return false;
      const maximized = win.getBounds();
      const normal = win.getNormalBounds();
      if (!maximized.width || !maximized.height || !normal.width || !normal.height) return false;
      if (active) active.cancelled = true;

      const ratioX = clamp((point.screenX - maximized.x) / maximized.width, 0, 1);
      const offsetX = Math.round(normal.width * ratioX);
      const offsetY = Math.round(clamp(point.screenY - maximized.y, 0, normal.height - 1));
      const session = {
        win, point, offsetX, offsetY,
        width: normal.width,
        height: normal.height,
        ready: false,
        ended: false,
        cancelled: false
      };
      active = session;

      win.unmaximize();
      // Windows 会在 unmaximize() 返回后继续写回系统还原位置。延迟到下一轮
      // 再应用拖拽坐标;期间先缓存最新光标,即使快速松开也不会跳回居中位置。
      defer(() => {
        if (session.cancelled || session.win.isDestroyed()) return;
        session.ready = true;
        apply(session);
        if (session.ended && active === session) active = null;
      });
      return true;
    },

    move(win, point) {
      if (!owns(win) || !validPoint(point)) return false;
      active.point = point;
      if (active.ready) apply(active);
      return true;
    },

    end(win) {
      if (!owns(win)) return false;
      active.ended = true;
      if (active.ready) active = null;
      return true;
    },

    cancel() {
      if (active) active.cancelled = true;
      active = null;
    }
  };
}

module.exports = { createMaximizedDrag };
