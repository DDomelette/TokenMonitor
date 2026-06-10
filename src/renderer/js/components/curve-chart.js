window.App = window.App || {};

function createCurveChart(config) {
  var echarts = window.echarts;
  var getTheme = window.Charts.getTheme;

  var chart = null;
  var chartDom = null;

  function init(containerId) {
    var dom = document.getElementById(containerId);
    if (!dom) return;
    chartDom = dom;
    var isDark = document.body.classList.contains('dark');
    chart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });
    var theme = getTheme(isDark);
    chart.setOption({
      color: theme.color,
      backgroundColor: theme.backgroundColor,
      textStyle: theme.textStyle,
      grid: theme.grid,
      xAxis: theme.xAxis,
      yAxis: theme.yAxis,
      tooltip: config.tooltip(theme),
      animation: false,
      series: config.series(isDark)
    });

    window.addEventListener('resize', function () {
      if (chart && chartDom) {
        chart.resize({ width: chartDom.clientWidth, height: chartDom.clientHeight });
      }
    });
  }

  function update(points) {
    if (!chart) return;
    var dates = points.map(function (p) {
      var d = new Date(p.time);
      return (d.getMonth() + 1) + '/' + d.getDate();
    });
    var totalData = points.map(function (p) { return p[config.totalField] || 0; });
    var deltaData = points.map(function (p) { return p[config.deltaField] || 0; });
    chart.setOption({
      xAxis: { data: dates },
      series: [{ data: totalData }, { data: deltaData }]
    });
  }

  function resize() {
    if (chart && chartDom) {
      chart.resize({ width: chartDom.clientWidth, height: chartDom.clientHeight });
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
        confine: true,
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
          name: '增量 Token', type: 'bar', barWidth: 4,
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
        confine: true,
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
          name: '增量费用', type: 'bar', barWidth: 4,
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
})();
