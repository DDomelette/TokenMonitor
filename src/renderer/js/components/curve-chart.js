window.App = window.App || {};

function createCurveChart(config) {
  var echarts = window.echarts;
  var getTheme = window.Charts.getTheme;

  var chart = null;
  var chartDom = null;
  var dataPointCount = 0;

  function isCardMode() {
    var item = chartDom && chartDom.closest('[data-layout-preset="card"]');
    return Boolean(item);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function dateLabelInterval(count, width) {
    var total = Number(count) || 0;
    if (total <= 1) return 0;
    var available = Number(width) || 320;
    var targetLabels = Math.max(2, Math.floor(available / 72));
    if (total <= targetLabels) return 0;
    return Math.max(0, Math.ceil(total / targetLabels) - 1);
  }

  function adaptiveAxisOptions(theme, compact) {
    if (compact) {
      return {
        grid: { top: 6, right: 8, bottom: 6, left: 8, containLabel: false },
        xAxis: {
          axisLabel: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false }
        },
        yAxis: {
          axisLabel: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false }
        }
      };
    }

    var width = chartDom ? chartDom.clientWidth : 320;
    var height = chartDom ? chartDom.clientHeight : 180;
    var axisFontSize = Math.round(clamp(Math.min(width / 38, height / 16), 8, 12));

    return {
      grid: {
        top: Math.round(clamp(height * 0.06, 10, 16)),
        right: Math.round(clamp(width * 0.03, 8, 14)),
        bottom: Math.round(clamp(height * 0.16, 24, 34)),
        left: Math.round(clamp(width * 0.12, 42, 58)),
        containLabel: false
      },
      xAxis: {
        axisLabel: {
          show: true,
          hideOverlap: true,
          fontSize: axisFontSize,
          interval: dateLabelInterval(dataPointCount, width)
        }
      },
      yAxis: {
        axisLabel: {
          show: true,
          hideOverlap: true,
          fontSize: axisFontSize
        },
        splitLine: { show: true }
      }
    };
  }

  function densityOptions(theme, compact) {
    var adaptive = adaptiveAxisOptions(theme, compact);
    if (compact) return adaptive;
    return {
      grid: adaptive.grid,
      xAxis: Object.assign({}, theme.xAxis, {
        axisLabel: Object.assign({ show: true }, theme.xAxis.axisLabel, {
          show: true,
          hideOverlap: true,
          fontSize: adaptive.xAxis.axisLabel.fontSize,
          interval: adaptive.xAxis.axisLabel.interval
        })
      }),
      yAxis: Object.assign({}, theme.yAxis, {
        axisLabel: Object.assign({ show: true }, theme.yAxis.axisLabel, {
          show: true,
          hideOverlap: true,
          fontSize: adaptive.yAxis.axisLabel.fontSize
        }),
        splitLine: Object.assign({ show: true }, theme.yAxis.splitLine)
      })
    };
  }

  function applyDensity() {
    if (!chart || !chartDom) return;
    var isDark = document.body.classList.contains('dark');
    var theme = getTheme(isDark);
    chart.setOption(densityOptions(theme, isCardMode()));
  }

  function init(containerId) {
    var dom = document.getElementById(containerId);
    if (!dom) return;
    chartDom = dom;
    var isDark = document.body.classList.contains('dark');
    chart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });
    var theme = getTheme(isDark);
    var density = densityOptions(theme, isCardMode());
    chart.setOption({
      color: theme.color,
      backgroundColor: theme.backgroundColor,
      textStyle: theme.textStyle,
      grid: density.grid,
      xAxis: density.xAxis,
      yAxis: density.yAxis,
      tooltip: config.tooltip(theme),
      animation: false,
      series: config.series(isDark)
    });
    applyDensity();

  }

  function update(points) {
    if (!chart) return;
    var dates = points.map(function (p) {
      var d = new Date(p.time);
      return (d.getMonth() + 1) + '/' + d.getDate();
    });
    dataPointCount = dates.length;
    var totalData = points.map(function (p) { return p[config.totalField] || 0; });
    var deltaData = points.map(function (p) { return p[config.deltaField] || 0; });
    chart.setOption({
      xAxis: { data: dates },
      series: [{ data: totalData }, { data: deltaData }]
    });
    applyDensity();
  }

  function resize() {
    if (chart && chartDom) {
      chart.resize({ width: chartDom.clientWidth, height: chartDom.clientHeight });
      applyDensity();
    }
  }

  function dispose() {
    if (chart) { chart.dispose(); chart = null; chartDom = null; }
  }

  return { init: init, update: update, resize: resize, dispose: dispose };
}

(function () {
  var echarts = window.echarts;

  var tokenChart = createCurveChart({
    totalField: 'totalTokens',
    deltaField: 'deltaTokens',
    tooltip: function (theme) {
      return {
        trigger: 'axis',
        appendToBody: true,
        confine: false,
        backgroundColor: theme.tooltip.backgroundColor,
        borderColor: theme.tooltip.borderColor,
        textStyle: theme.tooltip.textStyle,
        formatter: function (params) {
          return (params || []).map(function (p) {
            var val = p.value || 0;
            var label;
            if (val >= 1000000) label = (val / 1000000).toFixed(1) + 'M';
            else if (val >= 1000) label = (val / 1000).toFixed(0) + 'K';
            else label = val.toString();
            return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + p.color + '"></span> ' + p.seriesName + ': ' + label;
          }).join('<br/>');
        }
      };
    },
    series: function (isDark) {
      return [
        {
          name: '累计 Token',
          type: 'line', smooth: true, showSymbol: false,
          lineStyle: { color: '#74B8FC', width: 1.5 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(116,184,252,0.15)' },
              { offset: 1, color: 'rgba(116,184,252,0)' }
            ])
          },
          data: []
        },
        {
          name: '增量 Token', type: 'bar', barMaxWidth: 20,
          itemStyle: { color: 'rgba(116,184,252,0.4)' },
          data: []
        }
      ];
    }
  });

  var costChart = createCurveChart({
    totalField: 'totalCost',
    deltaField: 'deltaCost',
    tooltip: function (theme) {
      return {
        trigger: 'axis',
        appendToBody: true,
        confine: false,
        backgroundColor: theme.tooltip.backgroundColor,
        borderColor: theme.tooltip.borderColor,
        textStyle: theme.tooltip.textStyle,
        formatter: function (params) {
          return (params || []).map(function (p) {
            var val = p.value || 0;
            return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + p.color + '"></span> ' + p.seriesName + ': ¥' + val.toFixed(2);
          }).join('<br/>');
        }
      };
    },
    series: function (isDark) {
      return [
        {
          name: '累计费用', type: 'line', smooth: true, showSymbol: false,
          lineStyle: { color: '#22C55E', width: 1.5 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(34,197,94,0.15)' },
              { offset: 1, color: 'rgba(34,197,94,0)' }
            ])
          },
          data: []
        },
        {
          name: '增量费用', type: 'bar', barMaxWidth: 20,
          itemStyle: { color: 'rgba(34,197,94,0.35)' },
          data: []
        }
      ];
    }
  });

  window.App.initTokenChart = tokenChart.init;
  window.App.updateTokenChart = tokenChart.update;
  window.App.resizeTokenChart = tokenChart.resize;
  window.App.disposeTokenChart = tokenChart.dispose;
  window.App.initCostChart = costChart.init;
  window.App.updateCostChart = costChart.update;
  window.App.resizeCostChart = costChart.resize;
  window.App.disposeCostChart = costChart.dispose;
  if (window.ComponentRegistry) {
    window.ComponentRegistry.registerRuntime('token-line', {
      init: tokenChart.init,
      update: tokenChart.update,
      resize: tokenChart.resize,
      dispose: tokenChart.dispose
    });
    window.ComponentRegistry.registerRuntime('cost-line', {
      init: costChart.init,
      update: costChart.update,
      resize: costChart.resize,
      dispose: costChart.dispose
    });
  }
})();
