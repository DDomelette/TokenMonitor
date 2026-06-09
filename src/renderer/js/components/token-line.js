const echarts = require('echarts');
const { getTheme } = require('../charts');

let tokenChart = null;
let tokenChartDom = null;

function initTokenChart(containerId) {
  const dom = document.getElementById(containerId);
  if (!dom) return;
  tokenChartDom = dom;
  const isDark = document.body.classList.contains('dark');
  tokenChart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });
  tokenChart.setOption({
    ...getTheme(isDark),
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

  window.addEventListener('resize', () => {
    if (tokenChart && tokenChartDom) {
      tokenChart.resize({ width: tokenChartDom.clientWidth, height: tokenChartDom.clientHeight });
    }
  });
}

function updateTokenChart(points) {
  if (!tokenChart) return;
  const totalData = points.map(p => [p.time, p.totalTokens || 0]);
  const deltaData = points.map(p => [p.time, p.deltaTokens || 0]);
  tokenChart.setOption({ series: [{ data: totalData }, { data: deltaData }] });
}

function resizeTokenChart() {
  if (tokenChart && tokenChartDom) {
    tokenChart.resize({ width: tokenChartDom.clientWidth, height: tokenChartDom.clientHeight });
  }
}

function disposeTokenChart() {
  if (tokenChart) { tokenChart.dispose(); tokenChart = null; tokenChartDom = null; }
}

module.exports = { initTokenChart, updateTokenChart, resizeTokenChart, disposeTokenChart };
