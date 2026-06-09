const echarts = require('echarts');
const { getTheme } = require('../charts');

let costChart = null;
let costChartDom = null;

function initCostChart(containerId) {
  const dom = document.getElementById(containerId);
  if (!dom) return;
  costChartDom = dom;
  const isDark = document.body.classList.contains('dark');
  costChart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });
  costChart.setOption({
    ...getTheme(isDark),
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

  window.addEventListener('resize', () => {
    if (costChart && costChartDom) {
      costChart.resize({ width: costChartDom.clientWidth, height: costChartDom.clientHeight });
    }
  });
}

function updateCostChart(points) {
  if (!costChart) return;
  const totalData = points.map(p => [p.time, p.totalCost || 0]);
  const deltaData = points.map(p => [p.time, p.deltaCost || 0]);
  costChart.setOption({ series: [{ data: totalData }, { data: deltaData }] });
}

function resizeCostChart() {
  if (costChart && costChartDom) {
    costChart.resize({ width: costChartDom.clientWidth, height: costChartDom.clientHeight });
  }
}

function disposeCostChart() {
  if (costChart) { costChart.dispose(); costChart = null; costChartDom = null; }
}

module.exports = { initCostChart, updateCostChart, resizeCostChart, disposeCostChart };
