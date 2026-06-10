window.App = window.App || {};

(function () {
  var echarts = window.echarts;
  var getTheme = window.Charts.getTheme;

  var tokenChart = null;
  var tokenChartDom = null;

  function initTokenChart(containerId) {
    var dom = document.getElementById(containerId);
    if (!dom) return;
    tokenChartDom = dom;
    var isDark = document.body.classList.contains('dark');
    tokenChart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });
    var theme = getTheme(isDark);
    tokenChart.setOption({
      color: theme.color,
      backgroundColor: theme.backgroundColor,
      textStyle: theme.textStyle,
      grid: theme.grid,
      xAxis: theme.xAxis,
      yAxis: theme.yAxis,
      tooltip: {
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
      },
      animation: false,
      series: [
        {
          name: '累计 Token',
          type: 'line',
          smooth: true,
          showSymbol: false,
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
          name: '增量 Token',
          type: 'bar',
          barWidth: 4,
          itemStyle: { color: 'rgba(116,184,252,0.4)' },
          data: []
        }
      ]
    });

    window.addEventListener('resize', function () {
      if (tokenChart && tokenChartDom) {
        tokenChart.resize({ width: tokenChartDom.clientWidth, height: tokenChartDom.clientHeight });
      }
    });
  }

  function updateTokenChart(points) {
    if (!tokenChart) return;
    var dates = points.map(function (p) {
      var d = new Date(p.time);
      return (d.getMonth() + 1) + '/' + d.getDate();
    });
    var totalData = points.map(function (p) { return p.totalTokens || 0; });
    var deltaData = points.map(function (p) { return p.deltaTokens || 0; });
    tokenChart.setOption({
      xAxis: { data: dates },
      series: [{ data: totalData }, { data: deltaData }]
    });
  }

  function resizeTokenChart() {
    if (tokenChart && tokenChartDom) {
      tokenChart.resize({ width: tokenChartDom.clientWidth, height: tokenChartDom.clientHeight });
    }
  }

  function disposeTokenChart() {
    if (tokenChart) { tokenChart.dispose(); tokenChart = null; tokenChartDom = null; }
  }

  window.App.initTokenChart = initTokenChart;
  window.App.updateTokenChart = updateTokenChart;
  window.App.resizeTokenChart = resizeTokenChart;
  window.App.disposeTokenChart = disposeTokenChart;
})();
