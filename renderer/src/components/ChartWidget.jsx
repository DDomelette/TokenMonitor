// 图表组件:model-bar(每日 Token 堆叠柱)/ token-line / cost-line(曲线)。
// 密度自适应与主题逻辑从 curve-chart.js / model-bar.js / charts.js 平移。
import React, { useRef } from 'react';
import * as echarts from 'echarts';
import useECharts from '../hooks/useECharts.js';
import { getTheme, getBarTheme } from '../lib/chartTheme.js';
import { echartsWindowPosition as windowClampedPosition } from '../lib/floating-layer.js';

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

// 紧凑模式按实际容器尺寸判定,而不是 data-layout-preset 属性:
// 该属性随布局 memo 冻结,用户在编辑模式自由缩放后不同步,会导致宽图误判为 card 隐藏全部标签。
// 宽且矮的图(如 312x92)仍保留标签——宽屏矮图丢光标签正是用户感知的"信息全没了";
// 只有两个维度都很小(卡片形态)才隐藏坐标轴。
export function isCardMode(dom) {
  if (!dom) return false;
  return dom.clientWidth < 200 && dom.clientHeight < 130;
}

function dateLabelInterval(count, width) {
  const total = Number(count) || 0;
  if (total <= 1) return 0;
  const available = Number(width) || 320;
  const targetLabels = Math.max(2, Math.floor(available / 72));
  if (total <= targetLabels) return 0;
  return Math.max(0, Math.ceil(total / targetLabels) - 1);
}

function compactAxis() {
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

function curveAxisOptions(dom, dataPointCount) {
  const width = dom ? dom.clientWidth : 320;
  const height = dom ? dom.clientHeight : 180;
  const axisFontSize = Math.round(clamp(Math.min(width / 38, height / 16), 8, 12));
  // y 轴刻度按可用高度分级:模块被压矮时只留 2~3 档,避免标签挤成一团失去意义
  const yTicks = Math.round(clamp(Math.floor(height / 44), 2, 5));
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
      splitNumber: yTicks,
      axisLabel: {
        show: true,
        hideOverlap: true,
        fontSize: axisFontSize
      },
      splitLine: { show: true }
    }
  };
}

function curveDensity(theme, dom, compact, dataPointCount) {
  if (compact) return compactAxis();
  const adaptive = curveAxisOptions(dom, dataPointCount);
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
      splitNumber: adaptive.yAxis.splitNumber,
      axisLabel: Object.assign({ show: true }, theme.yAxis.axisLabel, {
        show: true,
        hideOverlap: true,
        fontSize: adaptive.yAxis.axisLabel.fontSize
      }),
      splitLine: Object.assign({ show: true }, theme.yAxis.splitLine)
    })
  };
}

export function barDensity(theme, dom, compact) {
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
  const width = dom ? dom.clientWidth : 320;
  const height = dom ? dom.clientHeight : 180;
  const axisFontSize = Math.round(clamp(Math.min(width / 38, height / 16), 8, 12));
  // y 轴刻度按可用高度分级:模块被压矮时只留 2~3 档,避免标签挤成一团失去意义
  const yTicks = Math.round(clamp(Math.floor(height / 44), 2, 5));
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
      splitNumber: yTicks,
      axisLabel: { show: true, fontSize: axisFontSize, hideOverlap: true },
      splitLine: { show: true, lineStyle: { color: theme.gridColor } }
    },
    series: [
      { barMaxWidth: Math.round(clamp(width * 0.04, 10, 20)) },
      { barMaxWidth: Math.round(clamp(width * 0.04, 10, 20)) },
      { barMaxWidth: Math.round(clamp(width * 0.04, 10, 20)) }
    ]
  };
}

export function formatToken(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return n.toString();
}

// 悬浮层定位原语已收敛到 lib/floating-layer.js;保留 re-export 兼容 ProviderBar 的 import。
export { windowClampedPosition };

function buildDailyOption(dom, dailyData) {
  const isDark = document.body.classList.contains('dark');
  const t = getBarTheme(isDark);
  const dates = [];
  const hitData = [];
  const missData = [];
  const completionData = [];
  // 平台按月返回零填充数据:截掉今天之后的空白天,避免图表尾部大片空白
  const now = new Date();
  const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  (dailyData || []).forEach((d) => {
    if (d.date > todayStr) return;
    dates.push(d.date.slice(5));
    hitData.push(d.cacheHit || 0);
    missData.push(d.cacheMiss || 0);
    completionData.push(d.completion || 0);
  });
  const density = barDensity(t, dom, isCardMode(dom));
  return {
    color: ['#22C55E', '#F97316', '#74B8FC'],
    backgroundColor: 'transparent',
    textStyle: { color: t.textColor, fontSize: 10 },
    grid: density.grid,
    tooltip: {
      trigger: 'axis',
      // 挂 body 避免被模块 overflow 裁切;位置钳制在窗口内,被遮挡时向中间靠拢
      appendToBody: true,
      position: windowClampedPosition(dom),
      axisPointer: { type: 'shadow' },
      textStyle: { fontSize: 11 },
      formatter: (params) => {
        let total = 0;
        const lookup = {};
        (params || []).forEach((p) => { total += p.value || 0; lookup[p.seriesName] = p; });
        const order = ['缓存命中', '缓存未命中', '输出 Token'];
        const parts = order.map((name) => {
          const p = lookup[name];
          if (!p) return '';
          return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + p.color + '"></span> ' + name + ': ' + formatToken(p.value);
        });
        return '<b>' + (params[0] ? params[0].axisValue : '') + '</b><br/>' + parts.join('<br/>') + '<br/><b>合计: ' + formatToken(total) + '</b>';
      }
    },
    xAxis: Object.assign({ type: 'category', data: dates }, density.xAxis),
    // density.yAxis.axisLabel 只含 show/fontSize,必须显式合并,否则 formatter 被整体覆盖丢千分位缩写
    yAxis: Object.assign({ type: 'value' }, density.yAxis, {
      axisLabel: Object.assign({ color: t.textColor, fontSize: 9, formatter: (v) => formatToken(v) }, density.yAxis.axisLabel)
    }),
    animation: true,
    series: [
      Object.assign({ name: '输出 Token', type: 'bar', stack: 'total', itemStyle: { borderRadius: [0, 0, 0, 0] }, data: completionData }, density.series && density.series[0]),
      Object.assign({ name: '缓存未命中', type: 'bar', stack: 'total', itemStyle: { borderRadius: [0, 0, 0, 0] }, data: missData }, density.series && density.series[1]),
      Object.assign({ name: '缓存命中', type: 'bar', stack: 'total', itemStyle: { borderRadius: [3, 3, 0, 0] }, data: hitData }, density.series && density.series[2])
    ]
  };
}

function buildCurveOption(dom, points, config) {
  const isDark = document.body.classList.contains('dark');
  const theme = getTheme(isDark);
  const dates = (points || []).map((p) => {
    const d = new Date(p.time);
    return (d.getMonth() + 1) + '/' + d.getDate();
  });
  const totalData = (points || []).map((p) => p[config.totalField] || 0);
  const deltaData = (points || []).map((p) => p[config.deltaField] || 0);
  const density = curveDensity(theme, dom, isCardMode(dom), dates.length);
  return {
    color: theme.color,
    backgroundColor: theme.backgroundColor,
    textStyle: theme.textStyle,
    grid: density.grid,
    // theme.xAxis 自带 data:[],必须把真实日期放在最后合并,否则覆盖为空导致 axis 触发失效、无 x 轴标签
    xAxis: Object.assign({ type: 'category' }, density.xAxis, { data: dates }),
    yAxis: Object.assign({ type: 'value' }, density.yAxis),
    tooltip: config.tooltip(theme, dom),
    animation: false,
    series: config.series(isDark, totalData, deltaData)
  };
}

// 与 model-bar 一致的悬浮窗:加粗日期头 + 圆点行;axisPointer 竖线跟随
function curveTooltip(theme, formatValue, dom) {
  return {
    trigger: 'axis',
    appendToBody: true,
    position: windowClampedPosition(dom),
    axisPointer: { type: 'line' },
    backgroundColor: theme.tooltip.backgroundColor,
    borderColor: theme.tooltip.borderColor,
    textStyle: theme.tooltip.textStyle,
    formatter: (params) => {
      const rows = (params || []).map((p) => {
        return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + p.color + '"></span> ' + p.seriesName + ': ' + formatValue(p.value || 0);
      }).join('<br/>');
      return '<b>' + (params && params[0] ? params[0].axisValue : '') + '</b><br/>' + rows;
    }
  };
}

const CURVE_CONFIGS = {
  'token-line': {
    totalField: 'totalTokens',
    deltaField: 'deltaTokens',
    tooltip: (theme, dom) => curveTooltip(theme, formatToken, dom),
    series: (isDark, totalData, deltaData) => [
      {
        name: '累计 Token', type: 'line', smooth: true, showSymbol: false,
        lineStyle: { color: '#74B8FC', width: 1.5 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(116,184,252,0.15)' },
            { offset: 1, color: 'rgba(116,184,252,0)' }
          ])
        },
        data: totalData
      },
      {
        name: '增量 Token', type: 'bar', barMaxWidth: 20,
        itemStyle: { color: 'rgba(116,184,252,0.4)' },
        data: deltaData
      }
    ]
  },
  'cost-line': {
    totalField: 'totalCost',
    deltaField: 'deltaCost',
    tooltip: (theme, dom) => curveTooltip(theme, (v) => '¥' + v.toFixed(2), dom),
    series: (isDark, totalData, deltaData) => [
      {
        name: '累计费用', type: 'line', smooth: true, showSymbol: false,
        lineStyle: { color: '#22C55E', width: 1.5 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(34,197,94,0.15)' },
            { offset: 1, color: 'rgba(34,197,94,0)' }
          ])
        },
        data: totalData
      },
      {
        name: '增量费用', type: 'bar', barMaxWidth: 20,
        itemStyle: { color: 'rgba(34,197,94,0.35)' },
        data: deltaData
      }
    ]
  }
};

export default function ChartWidget({ id, dashboard }) {
  const domRef = useRef(null);
  const stats = dashboard && dashboard.stats;
  const dailyData = stats && stats.tokenDaily;
  const curvePoints = dashboard && (id === 'token-line' ? dashboard.curveToken : dashboard.curveCost);

  const buildOption = () => {
    if (id === 'model-bar') return buildDailyOption(domRef.current, dailyData);
    const config = CURVE_CONFIGS[id];
    if (!config) return {};
    return buildCurveOption(domRef.current, curvePoints, config);
  };

  useECharts(domRef, buildOption, [id, dailyData, curvePoints]);

  return <div className="chart-container" ref={domRef} />;
}
