window.App = window.App || {};

(function () {
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

  window.addEventListener('DOMContentLoaded', function () {
    document.getElementById('minimizeBtn').addEventListener('click', function () {
      window.api.send('window:minimize');
    });

    document.getElementById('closeBtn').addEventListener('click', function () {
      window.api.send('window:minimize');
    });

    document.getElementById('settingsBtn').addEventListener('click', function () {
      window.App.openSettings();
    });

    window.App.initDragSort('.content');

    window.api.invoke('get:settings').then(function (settings) {
      window._settingsData = settings;
      applyComponentVisibility(settings);
      window.App.initSettings();

      var isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (isDark && settings.window && settings.window.followSystemTheme !== false) {
        document.body.classList.add('dark');
      }

      window.App.initTokenChart('token-chart');
      window.App.initCostChart('cost-chart');
    });

    window.api.on('data:update', function (stats) {
      window.App.updateFeeCards(null, stats);
      if (stats.models) window.App.updateModelBar(stats.models);
    });

    window.api.on('balance:update', function (balance) {
      window.App.updateFeeCards(balance, window._lastStats);
    });

    window.api.on('curve:token', function (data) {
      window.App.updateTokenChart(data.points);
    });

    window.api.on('curve:cost', function (data) {
      window.App.updateCostChart(data.points);
    });

    window.api.on('proxy:status', function (status) {
      var dot = document.getElementById('statusDot');
      var text = document.getElementById('statusText');
      var portSpan = document.getElementById('proxyPort');

      if (status.running) {
        dot.className = 'status-dot online';
        text.textContent = '代理运行中';
      } else {
        dot.className = 'status-dot offline';
        text.textContent = status.error ? '错误: ' + status.error : '代理已停止';
      }

      if (portSpan && status.port) {
        portSpan.textContent = 'localhost:' + status.port;
      }
    });

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
      window.App.initTokenChart('token-chart');
      window.App.initCostChart('cost-chart');
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
        window.App.initTokenChart('token-chart');
        window.App.initCostChart('cost-chart');
      }
    });

    window.addEventListener('resize', function () {
      window.App.resizeTokenChart();
      window.App.resizeCostChart();
    });
  });
})();
