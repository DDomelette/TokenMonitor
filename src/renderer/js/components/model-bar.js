window.App = window.App || {};

(function () {
  var echarts = window.echarts;
  var dailyChart = null;
  var dailyDom = null;

  function initDailyChart(containerId) {
    var dom = document.getElementById(containerId);
    if (!dom) return;
    dailyDom = dom;
    var isDark = document.body.classList.contains('dark');
    dailyChart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });

    dailyChart.setOption({
      color: ['#4D6BFE', '#7B92FF', '#A5B4FC', '#C7D2FE', '#E0E7FF', '#F97316', '#22C55E'],
      backgroundColor: 'transparent',
      textStyle: { color: isDark ? '#9CA3AF' : '#6B7280', fontSize: 10 },
      grid: { left: 48, right: 12, top: 16, bottom: 24 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        textStyle: { fontSize: 11 }
      },
      xAxis: {
        type: 'category',
        data: [],
        axisLabel: { color: isDark ? '#9CA3AF' : '#6B7280', fontSize: 9, rotate: 0, interval: 'auto' },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: isDark ? '#3A3C45' : '#E5E7EB' } }
      },
      yAxis: {
        type: 'value',
        name: 'tokens',
        nameTextStyle: { fontSize: 9, color: isDark ? '#9CA3AF' : '#6B7280' },
        axisLabel: { color: isDark ? '#9CA3AF' : '#6B7280', fontSize: 9, formatter: function (v) { return v >= 1000000 ? (v / 1000000).toFixed(1) + 'M' : v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v.toString(); } },
        splitLine: { lineStyle: { color: isDark ? '#2A2C35' : '#F3F4F6' } }
      },
      animation: true,
      series: [
        {
          name: 'Token 消耗',
          type: 'bar',
          barMaxWidth: 20,
          itemStyle: { borderRadius: [3, 3, 0, 0] },
          data: []
        }
      ]
    });

    window.addEventListener('resize', function () {
      if (dailyChart && dailyDom) {
        dailyChart.resize({ width: dailyDom.clientWidth, height: dailyDom.clientHeight });
      }
    });
  }

  function updateDailyChart(dailyData) {
    if (!dailyChart || !dailyData || !dailyData.length) return;

    var dates = [];
    var values = [];

    dailyData.forEach(function (d) {
      var day = d.date.slice(5);
      dates.push(day);
      values.push(d.total || 0);
    });

    dailyChart.setOption({
      xAxis: { data: dates },
      series: [{ data: values }]
    });
  }

  function resizeDailyChart() {
    if (dailyChart && dailyDom) {
      dailyChart.resize({ width: dailyDom.clientWidth, height: dailyDom.clientHeight });
    }
  }

  function disposeDailyChart() {
    if (dailyChart) { dailyChart.dispose(); dailyChart = null; dailyDom = null; }
  }

  window.App.initDailyChart = initDailyChart;
  window.App.updateDailyChart = updateDailyChart;
  window.App.resizeDailyChart = resizeDailyChart;
  window.App.disposeDailyChart = disposeDailyChart;
})();
