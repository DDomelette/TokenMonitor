window.App = window.App || {};

(function () {
  var echarts = window.echarts;
  var dailyChart = null;
  var dailyDom = null;

  function getTheme(isDark) {
    return {
      textColor: isDark ? '#9CA3AF' : '#6B7280',
      gridColor: isDark ? '#2A2C35' : '#F3F4F6',
      axisLineColor: isDark ? '#3A3C45' : '#E5E7EB'
    };
  }

  function isCardMode() {
    var item = dailyDom && dailyDom.closest('[data-layout-preset="card"]');
    return Boolean(item);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function densityOptions(theme, compact) {
    if (compact) {
      return {
        grid: { left: 8, right: 8, top: 6, bottom: 6 },
        xAxis: {
          axisLabel: { show: false },
          axisLine: { show: false },
          axisTick: { show: false }
        },
        yAxis: {
          name: '',
          axisLabel: { show: false },
          splitLine: { show: false }
        },
        series: [
          { barMaxWidth: 8 },
          { barMaxWidth: 8 },
          { barMaxWidth: 8 }
        ]
      };
    }

    var width = dailyDom ? dailyDom.clientWidth : 320;
    var height = dailyDom ? dailyDom.clientHeight : 180;
    var axisFontSize = Math.round(clamp(Math.min(width / 38, height / 16), 8, 12));

    return {
      grid: {
        left: Math.round(clamp(width * 0.13, 40, 52)),
        right: Math.round(clamp(width * 0.03, 8, 14)),
        top: Math.round(clamp(height * 0.09, 12, 16)),
        bottom: Math.round(clamp(height * 0.16, 22, 28))
      },
      xAxis: {
        axisLabel: { show: true, color: theme.textColor, fontSize: axisFontSize, rotate: 0, interval: 'auto', hideOverlap: true },
        axisLine: { show: true, lineStyle: { color: theme.axisLineColor } },
        axisTick: { show: false }
      },
      yAxis: {
        name: 'tokens',
        nameTextStyle: { fontSize: axisFontSize },
        axisLabel: { show: true, fontSize: axisFontSize },
        splitLine: { show: true, lineStyle: { color: theme.gridColor } }
      },
      series: [
        { barMaxWidth: Math.round(clamp(width * 0.04, 10, 20)) },
        { barMaxWidth: Math.round(clamp(width * 0.04, 10, 20)) },
        { barMaxWidth: Math.round(clamp(width * 0.04, 10, 20)) }
      ]
    };
  }

  function applyDensity() {
    if (!dailyChart || !dailyDom) return;
    var isDark = document.body.classList.contains('dark');
    dailyChart.setOption(densityOptions(getTheme(isDark), isCardMode()));
  }

  function initDailyChart(containerId) {
    var dom = document.getElementById(containerId);
    if (!dom) return;
    dailyDom = dom;
    var isDark = document.body.classList.contains('dark');
    var t = getTheme(isDark);
    dailyChart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });

    dailyChart.setOption({
      color: ['#22C55E', '#F97316', '#74B8FC'],
      backgroundColor: 'transparent',
      textStyle: { color: t.textColor, fontSize: 10 },
      grid: { left: 52, right: 12, top: 16, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        appendToBody: true,
        confine: false,
        axisPointer: { type: 'shadow' },
        textStyle: { fontSize: 11 },
        formatter: function (params) {
          var total = 0;
          var lookup = {};
          (params || []).forEach(function (p) { total += p.value || 0; lookup[p.seriesName] = p; });
          var order = ['缓存命中', '缓存未命中', '输出 Token'];
          var parts = order.map(function (name) {
            var p = lookup[name];
            if (!p) return '';
            return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + p.color + '"></span> ' + name + ': ' + (p.value >= 1000000 ? (p.value / 1000000).toFixed(1) + 'M' : p.value >= 1000 ? (p.value / 1000).toFixed(0) + 'K' : p.value);
          });
          return '<b>' + params[0].axisValue + '</b><br/>' + parts.join('<br/>') + '<br/><b>合计: ' + (total >= 1000000 ? (total / 1000000).toFixed(1) + 'M' : total >= 1000 ? (total / 1000).toFixed(0) + 'K' : total) + '</b>';
        }
      },
      xAxis: {
        type: 'category',
        data: [],
        axisLabel: { color: t.textColor, fontSize: 9, rotate: 0, interval: 'auto' },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: t.axisLineColor } }
      },
      yAxis: {
        type: 'value',
        name: 'tokens',
        nameTextStyle: { fontSize: 9, color: t.textColor },
        axisLabel: {
          color: t.textColor,
          fontSize: 9,
          formatter: function (v) { return v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v.toString(); }
        },
        splitLine: { lineStyle: { color: t.gridColor } }
      },
      animation: true,
      series: [
        { name: '输出 Token', type: 'bar', stack: 'total', barMaxWidth: 20, itemStyle: { borderRadius: [0, 0, 0, 0] }, data: [] },
        { name: '缓存未命中', type: 'bar', stack: 'total', barMaxWidth: 20, itemStyle: { borderRadius: [0, 0, 0, 0] }, data: [] },
        { name: '缓存命中', type: 'bar', stack: 'total', barMaxWidth: 20, itemStyle: { borderRadius: [3, 3, 0, 0] }, data: [] }
      ]
    });
    applyDensity();

  }

  function updateDailyChart(dailyData) {
    if (!dailyChart || !dailyData || !dailyData.length) return;

    var dates = [];
    var hitData = [];
    var missData = [];
    var completionData = [];

    dailyData.forEach(function (d) {
      dates.push(d.date.slice(5));
      hitData.push(d.cacheHit || 0);
      missData.push(d.cacheMiss || 0);
      completionData.push(d.completion || 0);
    });

    dailyChart.setOption({
      xAxis: { data: dates },
      series: [
        { data: completionData },
        { data: missData },
        { data: hitData }
      ]
    });
  }

  function resizeDailyChart() {
    if (dailyChart && dailyDom) {
      dailyChart.resize({ width: dailyDom.clientWidth, height: dailyDom.clientHeight });
      applyDensity();
    }
  }

  function disposeDailyChart() {
    if (dailyChart) { dailyChart.dispose(); dailyChart = null; dailyDom = null; }
  }

  window.App.initDailyChart = initDailyChart;
  window.App.updateDailyChart = updateDailyChart;
  window.App.resizeDailyChart = resizeDailyChart;
  window.App.disposeDailyChart = disposeDailyChart;
  if (window.ComponentRegistry) {
    window.ComponentRegistry.registerRuntime('model-bar', {
      init: initDailyChart,
      update: updateDailyChart,
      resize: resizeDailyChart,
      dispose: disposeDailyChart
    });
  }
})();
