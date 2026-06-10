window.App = window.App || {};

(function () {
  var lastRefreshTime = Date.now();
  var refreshTimer = null;

  function applyComponentVisibility(settings) {
    if (settings && settings.components && settings.components.feeCards === false) {
      var el = document.getElementById('fee-cards');
      if (el) el.classList.add('hidden');
    }
    if (settings && settings.components && settings.components.modelBar === false) {
      var el = document.getElementById('model-bar');
      if (el) el.classList.add('hidden');
    }
    if (settings && settings.components && settings.components.tokenLine === false) {
      var el = document.getElementById('token-line');
      if (el) el.classList.add('hidden');
    }
    if (settings && settings.components && settings.components.costLine === false) {
      var el = document.getElementById('cost-line');
      if (el) el.classList.add('hidden');
    }
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

  window.addEventListener('DOMContentLoaded', function () {
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

    window.App.initDragSort('.content');
    startRefreshTimer();

    window.api.invoke('get:settings').then(function (settings) {
      window._settingsData = settings;
      applyComponentVisibility(settings);

      var isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (isDark && settings.window && settings.window.followSystemTheme !== false) {
        document.body.classList.add('dark');
      }

      window.App.initTokenChart('token-chart');
      window.App.initCostChart('cost-chart');
      window.App.initDailyChart('daily-chart');

      setTimeout(pollDashboard, 500);
    });

    setInterval(pollDashboard, 10000);

    window.api.on('settings:loaded', function (settings) {
      window._settingsData = settings;
      applyComponentVisibility(settings);
    });

    window.api.on('open:settings', function () {
      window.App.openSettings();
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
      window.App.resizeTokenChart();
      window.App.resizeCostChart();
    });
  });
})();
