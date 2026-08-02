window.App = window.App || {};
window._isLayoutLocked = true;

(function () {
  var ws = window._ws;
  var lastRefreshTime = Date.now();
  var refreshTimer = null;
  var chartResizeFrame = null;

  function scheduleChartResize() {
    if (chartResizeFrame !== null) return;
    chartResizeFrame = requestAnimationFrame(function () {
      chartResizeFrame = null;
      window.ComponentRegistry.list().forEach(function (component) {
        var runtime = window.ComponentRegistry.getRuntime(component.id);
        if (runtime && runtime.resize) runtime.resize();
      });
    });
  }

  window.App.scheduleChartResize = scheduleChartResize;

  function getSetting(source, path) {
    return path.split('.').reduce(function (value, part) {
      return value && value[part] !== undefined ? value[part] : undefined;
    }, source);
  }

  function applyComponentVisibility(settings) {
    window.ComponentRegistry.list().forEach(function (component) {
      var visible = getSetting(settings, component.settingsKey) !== false;
      window.AppLayout.setComponentVisible(component.id, visible);
    });
  }

  function updateRefreshTimer() {
    var elapsed = Math.floor((Date.now() - lastRefreshTime) / 60000);
    var el = document.getElementById('refreshTime');
    if (el) {
      if (elapsed === 0) {
        el.textContent = '刚刚刷新';
      } else {
        el.textContent = elapsed + ' 分钟前';
      }
    }
  }

  function startRefreshTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    updateRefreshTimer();
    refreshTimer = setInterval(updateRefreshTimer, 15000);
  }

  function updateStatusBar(status) {
    var dot = document.getElementById('statusDot');
    var text = document.getElementById('statusText');

    if (status.running) {
      dot.className = 'status-dot online';
      text.textContent = '数据连接正常';
    } else {
      dot.className = 'status-dot offline';
      text.textContent = status.error || '未获取数据';
    }
  }

  function pollDashboard() {
    window.api.invoke('get:dashboard').then(function (dashboard) {
      lastRefreshTime = Date.now();
      updateRefreshTimer();
      if (dashboard.stats) {
        window.App.updateFeeCards(dashboard.balance, dashboard.stats);
        if (dashboard.stats.tokenDaily) {
          window.App.updateDailyChart(dashboard.stats.tokenDaily);
        }
      } else if (dashboard.balance) {
        window.App.updateFeeCards(dashboard.balance, null);
      }
      if (dashboard.curveToken && dashboard.curveToken.length > 0) {
        window.App.updateTokenChart(dashboard.curveToken);
      }
      if (dashboard.curveCost && dashboard.curveCost.length > 0) {
        window.App.updateCostChart(dashboard.curveCost);
      }
      if (dashboard.proxyStatus) {
        updateStatusBar(dashboard.proxyStatus);
      }
    }).catch(function () {});
  }

  /* ======== Resize ======== */

  var _resizeStartScreenX = 0;
  var _resizeStartScreenY = 0;
  var _resizeStartWinX = 0;
  var _resizeStartWinY = 0;
  var _resizeStartWinW = 0;
  var _resizeStartWinH = 0;
  var _resizeCursor = '';
  var _cssScale = 1;
  var _targetBounds = null;
  var _pendingRestore = null;
  var _restoreFallbackTimer = null;

  // 透明窗口快速缩放时, 渲染帧与 setBounds 之间存在 JS 侧无法消除的
  // 竞态: 要么旧帧被缩小的窗口裁剪(圆角变直角), 要么 #app 让出的
  // 透明区残留旧像素。因此拖动期间通过 is-window-resizing 类把窗口
  // 临时渲染为不透明的直角实心窗口, 任何帧竞态都不可见; 松手且原生
  // 窗口落定后再恢复圆角与透明。
  function setWindowResizingClass(active) {
    document.documentElement.classList.toggle('is-window-resizing', active);
  }

  function requestBounds(bounds) {
    window.api.send('window:set-bounds', bounds);
  }

  function scheduleRoundedRestore(target) {
    _pendingRestore = target;
    if (_restoreFallbackTimer) clearTimeout(_restoreFallbackTimer);
    _restoreFallbackTimer = setTimeout(function () {
      _restoreFallbackTimer = null;
      _pendingRestore = null;
      setWindowResizingClass(false);
    }, 500);
  }

  function maybeRestoreRounded() {
    if (!_pendingRestore) return;
    if (window.innerWidth === Math.round(_pendingRestore.width * _cssScale)
        && window.innerHeight === Math.round(_pendingRestore.height * _cssScale)) {
      _pendingRestore = null;
      if (_restoreFallbackTimer) {
        clearTimeout(_restoreFallbackTimer);
        _restoreFallbackTimer = null;
      }
      setWindowResizingClass(false);
    }
  }

  function onResizeStart(e, edge) {
    e.preventDefault();
    e.stopPropagation();
    ws.resizing = true;
    ws.resizeEdge = edge;
    _resizeStartScreenX = e.screenX;
    _resizeStartScreenY = e.screenY;
    _resizeStartWinX = ws.x;
    _resizeStartWinY = ws.y;
    _resizeStartWinW = ws.width;
    _resizeStartWinH = ws.height;
    ws.targetX = ws.x; ws.targetY = ws.y;
    ws.targetWidth = ws.width; ws.targetHeight = ws.height;
    _cssScale = window.innerWidth > 0 && ws.width > 0 ? window.innerWidth / ws.width : 1;
    _targetBounds = null;
    _pendingRestore = null;
    setWindowResizingClass(true);
    _resizeCursor = getComputedStyle(document.querySelector('.resize-' + edge)).cursor;
    document.body.style.cursor = _resizeCursor;
    document.body.style.userSelect = 'none';
  }

  /* ======== Shared mouse handlers ======== */

  document.addEventListener('mousemove', function (e) {
    if (ws.resizing) {
      var dx = e.screenX - _resizeStartScreenX;
      var dy = e.screenY - _resizeStartScreenY;
      var edge = ws.resizeEdge;
      var newW = _resizeStartWinW;
      var newH = _resizeStartWinH;
      var newX = _resizeStartWinX;
      var newY = _resizeStartWinY;

      if (edge.indexOf('e') !== -1) newW = Math.min(ws.maxWidth, Math.max(ws.minWidth, _resizeStartWinW + dx));
      if (edge.indexOf('w') !== -1) {
        newW = Math.min(ws.maxWidth, Math.max(ws.minWidth, _resizeStartWinW - dx));
        newX = _resizeStartWinX + _resizeStartWinW - newW;
      }
      if (edge.indexOf('s') !== -1) newH = Math.min(ws.maxHeight, Math.max(ws.minHeight, _resizeStartWinH + dy));
      if (edge.indexOf('n') !== -1) {
        newH = Math.min(ws.maxHeight, Math.max(ws.minHeight, _resizeStartWinH - dy));
        newY = _resizeStartWinY + _resizeStartWinH - newH;
      }

      var target = { x: newX, y: newY, width: newW, height: newH };
      ws.targetX = newX; ws.targetY = newY;
      ws.targetWidth = newW; ws.targetHeight = newH;
      _targetBounds = target;
      requestBounds(target);
      return;
    }
  });

  document.addEventListener('mouseup', function () {
    if (ws.resizing) {
      ws.resizing = false;
      ws.resizeEdge = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (_targetBounds) {
        requestBounds(_targetBounds);
        // 等原生窗口落到最终尺寸后再恢复圆角与透明
        scheduleRoundedRestore(_targetBounds);
        maybeRestoreRounded();
      } else {
        setWindowResizingClass(false);
      }
      _targetBounds = null;
      window.api.send('resize:end');
      window.AppLayout.resize();
      scheduleChartResize();
    }
  });

  /* ======== Init ======== */

  function initBounds() {
    window.api.invoke('get:bounds').then(function (bounds) {
      if (bounds) {
        ws.init(bounds.x, bounds.y, bounds.width, bounds.height);
      }
    }).catch(function () {
      ws.init(0, 0, window.innerWidth, window.innerHeight);
    });
  }

  function bindContentScrollbar() {
    var content = document.querySelector('.content');
    if (!content || content.dataset.scrollbarBound === 'true') return;
    var scrollClearTimer = null;
    content.dataset.scrollbarBound = 'true';
    content.addEventListener('scroll', function () {
      content.classList.add('is-scrolling');
      if (scrollClearTimer) clearTimeout(scrollClearTimer);
      scrollClearTimer = setTimeout(function () {
        content.classList.remove('is-scrolling');
        scrollClearTimer = null;
      }, 700);
    }, { passive: true });
  }

  window.addEventListener('DOMContentLoaded', function () {
    bindContentScrollbar();

    window.api.on('window:bounds-changed', function (bounds) {
      if (!bounds || ws.resizing) return;
      ws.init(bounds.x, bounds.y, bounds.width, bounds.height);
      ws.vx = 0;
      ws.vy = 0;
    });

    initBounds();
    window._runtime.start();

    window.addEventListener('wheel', function (e) {
      if (e.ctrlKey) {
        e.preventDefault();
        window.api.send('zoom:change', { delta: e.deltaY < 0 ? 0.1 : -0.1 });
      }
    }, { passive: false });

    document.getElementById('minimizeBtn').addEventListener('click', function () {
      window.api.send('window:minimize');
    });

    document.getElementById('closeBtn').addEventListener('click', function () {
      window.api.send('window:minimize');
    });

    document.getElementById('settingsBtn').addEventListener('click', function () {
      window.api.send('open:settings');
    });

    document.getElementById('refreshBtn').addEventListener('click', function () {
      window.api.send('refresh:dashboard');
    });

    startRefreshTimer();

    var edges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    edges.forEach(function (edge) {
      var el = document.querySelector('.resize-' + edge);
      if (el) {
        el.addEventListener('mousedown', function (e) { onResizeStart(e, edge); });
      }
    });

    window.api.invoke('get:settings').then(function (settings) {
      window._settingsData = settings;
      window.AppLayout.init(settings);
      applyComponentVisibility(settings);

      var isDark = false;
      var dm = settings.window && settings.window.darkMode;
      if (dm === 'dark') {
        isDark = true;
      } else if (dm === 'light') {
        isDark = false;
      } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
        isDark = true;
      }
      if (isDark) document.body.classList.add('dark');

      window.api.on('theme:changed', function (mode) {
        document.body.classList.toggle('dark', mode === 'dark');
      });

      window.App.initTokenChart('token-chart');
      window.App.initCostChart('cost-chart');
      window.App.initDailyChart('daily-chart');

      setTimeout(pollDashboard, 500);
    });

    setInterval(pollDashboard, 10000);

    window.api.on('settings:loaded', function (settings) {
      window._settingsData = settings;
      window.AppLayout.applySettings(settings);
      applyComponentVisibility(settings);
    });

    window.api.on('open:settings', function () {
      window.api.send('open:settings');
    });

    window.api.on('theme:changed', function (theme) {
      if (theme === 'dark') {
        document.body.classList.add('dark');
      } else {
        document.body.classList.remove('dark');
      }
      window.App.disposeTokenChart();
      window.App.disposeCostChart();
      window.App.disposeDailyChart();
      window.App.initTokenChart('token-chart');
      window.App.initCostChart('cost-chart');
      window.App.initDailyChart('daily-chart');
    });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
      if (window._settingsData && window._settingsData.window && window._settingsData.window.followSystemTheme !== false) {
        if (e.matches) {
          document.body.classList.add('dark');
        } else {
          document.body.classList.remove('dark');
        }
        window.App.disposeTokenChart();
        window.App.disposeCostChart();
        window.App.disposeDailyChart();
        window.App.initTokenChart('token-chart');
        window.App.initCostChart('cost-chart');
        window.App.initDailyChart('daily-chart');
      }
    });

    window.addEventListener('resize', function () {
      // 原生窗口落到最终尺寸后, 恢复圆角与透明
      maybeRestoreRounded();
      window.AppLayout.resize();
      scheduleChartResize();
    });
  });
})();
