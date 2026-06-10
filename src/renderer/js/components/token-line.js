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
      tooltip: theme.tooltip,
      animation: false,
      series: [
        {
          name: '累计 Token',
          type: 'line',
          smooth: true,
          showSymbol: false,
          lineStyle: { color: '#4D6BFE', width: 1.5 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(77,107,254,0.15)' },
              { offset: 1, color: 'rgba(77,107,254,0)' }
            ])
          },
          data: []
        },
        {
          name: '增量 Token',
          type: 'bar',
          barWidth: 2,
          itemStyle: { color: 'rgba(77,107,254,0.35)' },
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
