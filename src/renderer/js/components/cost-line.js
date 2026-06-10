window.App = window.App || {};

(function () {
  var echarts = window.echarts;
  var getTheme = window.Charts.getTheme;

  var costChart = null;
  var costChartDom = null;

  function initCostChart(containerId) {
    var dom = document.getElementById(containerId);
    if (!dom) return;
    costChartDom = dom;
    var isDark = document.body.classList.contains('dark');
    costChart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });
    var theme = getTheme(isDark);
    costChart.setOption({
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
            return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + p.color + '"></span> ' + p.seriesName + ': ¥' + val.toFixed(2);
          }).join('<br/>');
        }
      },
      animation: false,
      series: [
        {
          name: '累计费用',
          type: 'line',
          smooth: true,
          showSymbol: false,
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
          name: '增量费用',
          type: 'bar',
          barWidth: 2,
          itemStyle: { color: 'rgba(34,197,94,0.35)' },
          data: []
        }
      ]
    });

    window.addEventListener('resize', function () {
      if (costChart && costChartDom) {
        costChart.resize({ width: costChartDom.clientWidth, height: costChartDom.clientHeight });
      }
    });
  }

  function updateCostChart(points) {
    if (!costChart) return;
    var dates = points.map(function (p) {
      var d = new Date(p.time);
      return (d.getMonth() + 1) + '/' + d.getDate();
    });
    var totalData = points.map(function (p) { return p.totalCost || 0; });
    var deltaData = points.map(function (p) { return p.deltaCost || 0; });
    costChart.setOption({
      xAxis: { data: dates },
      series: [{ data: totalData }, { data: deltaData }]
    });
  }

  function resizeCostChart() {
    if (costChart && costChartDom) {
      costChart.resize({ width: costChartDom.clientWidth, height: costChartDom.clientHeight });
    }
  }

  function disposeCostChart() {
    if (costChart) { costChart.dispose(); costChart = null; costChartDom = null; }
  }

  window.App.initCostChart = initCostChart;
  window.App.updateCostChart = updateCostChart;
  window.App.resizeCostChart = resizeCostChart;
  window.App.disposeCostChart = disposeCostChart;
})();
