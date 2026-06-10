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

  function initDailyChart(containerId) {
    var dom = document.getElementById(containerId);
    if (!dom) return;
    dailyDom = dom;
    var isDark = document.body.classList.contains('dark');
    var t = getTheme(isDark);
    dailyChart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });

    dailyChart.setOption({
      color: ['#22C55E', '#F97316', '#4D6BFE'],
      backgroundColor: 'transparent',
      textStyle: { color: t.textColor, fontSize: 10 },
      grid: { left: 52, right: 12, top: 16, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        textStyle: { fontSize: 11 },
        formatter: function (params) {
          var total = 0;
          var parts = (params || []).map(function (p) {
            total += p.value || 0;
            return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + p.color + '"></span> ' + p.seriesName + ': ' + (p.value >= 1000000 ? (p.value / 1000000).toFixed(1) + 'M' : p.value >= 1000 ? (p.value / 1000).toFixed(0) + 'K' : p.value);
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
        { name: '缓存命中', type: 'bar', stack: 'total', barMaxWidth: 20, itemStyle: { borderRadius: [0, 0, 0, 0] }, data: [] },
        { name: '缓存未命中', type: 'bar', stack: 'total', barMaxWidth: 20, itemStyle: { borderRadius: [0, 0, 0, 0] }, data: [] },
        { name: '输出 Token', type: 'bar', stack: 'total', barMaxWidth: 20, itemStyle: { borderRadius: [3, 3, 0, 0] }, data: [] }
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
        { data: hitData },
        { data: missData },
        { data: completionData }
      ]
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
