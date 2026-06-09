const { updateFeeCards } = require('./components/fee-cards');
const { updateModelBar } = require('./components/model-bar');
const { initTokenChart, updateTokenChart, resizeTokenChart, disposeTokenChart } = require('./components/token-line');
const { initCostChart, updateCostChart, resizeCostChart, disposeCostChart } = require('./components/cost-line');
const { initDragSort } = require('./components/drag-sort');
const { initSettings, openSettings } = require('./settings');

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('minimizeBtn').addEventListener('click', () => {
    window.api.send('window:minimize');
  });

  document.getElementById('closeBtn').addEventListener('click', () => {
    window.api.send('window:minimize');
  });

  document.getElementById('settingsBtn').addEventListener('click', () => {
    openSettings();
  });

  initDragSort('.content');

  window.api.invoke('get:settings').then(settings => {
    window._settingsData = settings;
    applyComponentVisibility(settings);
    initSettings();

    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark && settings.window?.followSystemTheme !== false) {
      document.body.classList.add('dark');
    }

    initTokenChart('token-chart');
    initCostChart('cost-chart');
  });

  window.api.on('data:update', (stats) => {
    updateFeeCards(null, stats);
    if (stats.models) updateModelBar(stats.models);
  });

  window.api.on('balance:update', (balance) => {
    const lastStats = window._lastStats;
    updateFeeCards(balance, lastStats);
  });

  window.api.on('curve:token', ({ points }) => {
    updateTokenChart(points);
  });

  window.api.on('curve:cost', ({ points }) => {
    updateCostChart(points);
  });

  window.api.on('proxy:status', (status) => {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const portSpan = document.getElementById('proxyPort');

    if (status.running) {
      dot.className = 'status-dot online';
      text.textContent = '代理运行中';
    } else {
      dot.className = 'status-dot offline';
      text.textContent = status.error ? `错误: ${status.error}` : '代理已停止';
    }

    if (portSpan && status.port) {
      portSpan.textContent = `localhost:${status.port}`;
    }
  });

  window.api.on('settings:loaded', (settings) => {
    window._settingsData = settings;
    applyComponentVisibility(settings);
  });

  window.api.on('open:settings', () => {
    openSettings();
  });

  window.api.on('theme:changed', (theme) => {
    if (theme === 'dark') {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
    disposeTokenChart();
    disposeCostChart();
    initTokenChart('token-chart');
    initCostChart('cost-chart');
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (window._settingsData?.window?.followSystemTheme !== false) {
      if (e.matches) {
        document.body.classList.add('dark');
      } else {
        document.body.classList.remove('dark');
      }
      disposeTokenChart();
      disposeCostChart();
      initTokenChart('token-chart');
      initCostChart('cost-chart');
    }
  });

  window.addEventListener('resize', () => {
    resizeTokenChart();
    resizeCostChart();
  });
});

function applyComponentVisibility(settings) {
  if (settings?.components?.feeCards === false) {
    document.getElementById('fee-cards')?.classList.add('hidden');
  }
  if (settings?.components?.modelBar === false) {
    document.getElementById('model-bar')?.classList.add('hidden');
  }
  if (settings?.components?.tokenLine === false) {
    document.getElementById('token-line')?.classList.add('hidden');
  }
  if (settings?.components?.costLine === false) {
    document.getElementById('cost-line')?.classList.add('hidden');
  }
}
