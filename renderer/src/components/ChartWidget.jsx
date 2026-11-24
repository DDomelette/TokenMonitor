// 统一统计图：model-bar 按模型堆叠；token-line / cost-line 展示日增与区间累计。
import React, { useRef } from 'react';
import echarts from '../lib/echarts.js';
import useECharts from '../hooks/useECharts.js';
import useBeijingDayKey from '../hooks/useBeijingDayKey.js';
import { getTheme, getBarTheme, getSemanticChartTheme, colorWithAlpha } from '../lib/chartTheme.js';
import useSemanticChartTheme from '../hooks/useSemanticChartTheme.js';
import { echartsWindowPosition as windowClampedPosition } from '../lib/floating-layer.js';
import { useUsageCharts } from '../store.js';
import { useChartRange } from './ChartRange.jsx';
import UsageChartFrame from './UsageChartFrame.jsx';

const COPY = {
  'model-bar': { title: 'DeepSeek Token 构成', subtitle: '按模型堆叠 · 每日' },
  'token-line': { title: 'DeepSeek Token 趋势', subtitle: '每日用量与区间累计' },
  'cost-line': { title: 'DeepSeek 费用趋势', subtitle: '每日费用与区间累计' }
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function isCardMode(dom) {
  if (!dom) return false;
  return dom.clientWidth < 200 && dom.clientHeight < 130;
}

function dateLabelInterval(count, width) {
  const total = Number(count) || 0;
  if (total <= 1) return 0;
  const targetLabels = Math.max(2, Math.floor((Number(width) || 320) / 72));
  if (total <= targetLabels) return 0;
  return Math.max(0, Math.ceil(total / targetLabels) - 1);
}

function chartMotion() {
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduced ? { animation: false } : {
    animation: true,
    animationDuration: 0,
    animationDurationUpdate: 240,
    animationEasingUpdate: 'cubicOut'
  };
}

export function barDensity(theme, dom, compact, pointCount = 30) {
  if (compact) {
    return {
      grid: { left: 8, right: 8, top: 6, bottom: 6 },
      barMaxWidth: 8,
      xAxis: {
        axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false }
      },
      yAxis: { axisLabel: { show: false }, splitLine: { show: false } }
    };
  }
  const width = dom ? dom.clientWidth : 320;
  const height = dom ? dom.clientHeight : 180;
  const axisFontSize = Math.round(clamp(Math.min(width / 42, height / 13), 9, 11));
  const yTicks = Math.round(clamp(Math.floor(height / 44), 2, 4));
  return {
    grid: { left: 48, right: 12, top: 10, bottom: 26 },
    barMaxWidth: Math.round(clamp((width / Math.max(1, pointCount)) * 0.58, 4, 20)),
    xAxis: {
      axisLabel: {
        show: true, color: theme.textColor, fontSize: axisFontSize, rotate: 0,
        interval: dateLabelInterval(pointCount, width), hideOverlap: true, margin: 10
      },
      axisLine: { show: true, lineStyle: { color: theme.axisLineColor } },
      axisTick: { show: false }
    },
    yAxis: {
      splitNumber: yTicks,
      axisLabel: { show: true, color: theme.textColor, fontSize: axisFontSize, hideOverlap: true },
      splitLine: { show: true, lineStyle: { color: theme.gridColor, type: 'dashed' } }
    }
  };
}

function trendDensity(theme, dom, compact, pointCount) {
  const density = barDensity(theme, dom, compact, pointCount);
  if (compact) return density;
  return Object.assign({}, density, {
    grid: { left: 48, right: 48, top: 10, bottom: 26 }
  });
}

export function formatToken(value) {
  const n = Number(value) || 0;
  if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'K';
  return Math.round(n).toLocaleString('en-US');
}

function exactToken(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-US') + ' Token';
}

export function formatCost(value) {
  return '¥' + (Number(value) || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function fullDate(dates, params) {
  const index = params && params[0] ? params[0].dataIndex : -1;
  return dates[index] ? dates[index].replace(/-/g, '/') : '';
}

function tooltipRow(param, formatter) {
  const color = typeof param.color === 'string' ? param.color : 'currentColor';
  return '<div style="display:flex;align-items:center;justify-content:space-between;gap:20px;line-height:20px">'
    + '<span style="display:flex;align-items:center;gap:7px;min-width:0">'
    + '<span style="width:7px;height:7px;border-radius:50%;background:' + color + ';flex:none"></span>'
    + '<span>' + escapeHtml(param.seriesName) + '</span></span>'
    + '<b style="font-weight:600">' + escapeHtml(formatter(param.value)) + '</b></div>';
}

function tooltipShell(theme, dom, formatter, pointerType) {
  return Object.assign({}, theme.tooltip, {
    trigger: 'axis',
    appendToBody: true,
    position: windowClampedPosition(dom),
    axisPointer: { type: pointerType || 'shadow' },
    padding: [9, 11],
    borderWidth: 1,
    extraCssText: 'border-radius:9px;box-shadow:var(--chart-tooltip-shadow);',
    formatter
  });
}

export function buildStackedOption(dom, dates, inputSeries) {
  const palette = getSemanticChartTheme(document.body.classList.contains('dark'));
  const barTheme = getBarTheme(palette.isDark, palette);
  const theme = getTheme(palette.isDark, palette);
  const series = inputSeries || [];
  const density = barDensity(barTheme, dom, isCardMode(dom), dates.length);
  return Object.assign({
    color: series.map((item) => item.color),
    backgroundColor: 'transparent',
    textStyle: theme.textStyle,
    grid: density.grid,
    tooltip: tooltipShell(theme, dom, (params) => {
      const list = params || [];
      const total = list.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
      return '<div style="font-weight:600;margin-bottom:6px">' + fullDate(dates, list) + '</div>'
        + list.slice().reverse().map((item) => tooltipRow(item, exactToken)).join('')
        + '<div style="display:flex;justify-content:space-between;gap:20px;border-top:1px solid rgba(148,163,184,.25);margin-top:6px;padding-top:6px">'
        + '<span>合计</span><b>' + exactToken(total) + '</b></div>';
    }),
    xAxis: Object.assign({ type: 'category', data: dates.map((date) => date.slice(5).replace('-', '/')) }, density.xAxis),
    yAxis: Object.assign({ type: 'value', min: 0 }, density.yAxis, {
      axisLabel: Object.assign({}, density.yAxis.axisLabel, { formatter: formatToken })
    })
  }, chartMotion(), {
    series: series.map((item, index) => ({
      name: item.name,
      type: 'bar',
      stack: 'total',
      barMaxWidth: density.barMaxWidth,
      emphasis: { focus: 'series' },
      itemStyle: {
        color: item.color,
        borderRadius: index === series.length - 1 ? [4, 4, 0, 0] : 0
      },
      data: item.data
    }))
  });
}

export function buildTrendOption(dom, dates, metric, config) {
  const palette = getSemanticChartTheme(document.body.classList.contains('dark'));
  const barTheme = getBarTheme(palette.isDark, palette);
  const theme = getTheme(palette.isDark, palette);
  const density = trendDensity(barTheme, dom, isCardMode(dom), dates.length);
  const data = metric || { daily: [], cumulative: [] };
  const formatter = config.formatter;
  const axisFormatter = config.axisFormatter || formatter;
  const dailyAxisFormatter = config.dailyAxisFormatter || axisFormatter;
  return Object.assign({
    backgroundColor: 'transparent',
    textStyle: theme.textStyle,
    grid: density.grid,
    tooltip: tooltipShell(theme, dom, (params) => {
      const list = params || [];
      return '<div style="font-weight:600;margin-bottom:6px">' + fullDate(dates, list) + '</div>'
        + list.map((item) => tooltipRow(item, formatter)).join('');
    }, 'line'),
    xAxis: Object.assign({ type: 'category', data: dates.map((date) => date.slice(5).replace('-', '/')) }, density.xAxis),
    yAxis: [
      Object.assign({ type: 'value', min: 0 }, density.yAxis, {
        axisLabel: Object.assign({}, density.yAxis.axisLabel, { formatter: dailyAxisFormatter })
      }),
      {
        type: 'value', min: 0,
        splitNumber: density.yAxis.splitNumber,
        axisLabel: {
          show: !isCardMode(dom), color: barTheme.textColor,
          fontSize: density.yAxis.axisLabel.fontSize || 9,
          formatter: axisFormatter, hideOverlap: true
        },
        axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false }
      }
    ]
  }, chartMotion(), {
    series: [
      {
        name: config.dailyName,
        type: 'bar',
        yAxisIndex: 0,
        barMaxWidth: density.barMaxWidth,
        itemStyle: { color: config.barColor, borderRadius: [4, 4, 0, 0] },
        data: data.daily
      },
      {
        name: config.cumulativeName,
        type: 'line',
        yAxisIndex: 1,
        smooth: 0.18,
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { color: config.color, width: 2 },
        itemStyle: { color: config.color },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: config.areaColor },
            { offset: 1, color: colorWithAlpha(config.color, 0) }
          ])
        },
        data: data.cumulative
      }
    ]
  });
}

// 悬浮层定位原语保留 re-export，兼容既有调用与测试。
export { windowClampedPosition };

export default function ChartWidget({ id }) {
  const domRef = useRef(null);
  const today = useBeijingDayKey();
  const theme = useSemanticChartTheme();
  const { days } = useChartRange();
  const data = useUsageCharts({ days, today });
  const copy = COPY[id];
  const isModel = id === 'model-bar';
  const metric = data ? (isModel || id === 'token-line' ? data.deepseekTokens : data.deepseekCost) : null;
  const modelSeries = data ? data.models.map((item, index) => Object.assign({}, item, {
    color: theme.modelColors[index % theme.modelColors.length]
  })) : [];
  const trendColor = id === 'cost-line' ? theme.cost : theme.primary;
  const trendConfig = {
    color: trendColor,
    barColor: colorWithAlpha(trendColor, 0.38),
    areaColor: colorWithAlpha(trendColor, 0.14),
    formatter: id === 'cost-line' ? formatCost : exactToken,
    axisFormatter: id === 'cost-line'
      ? (value) => '¥' + Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
      : formatToken,
    dailyAxisFormatter: id === 'cost-line'
      ? (value) => '¥' + Number(value).toLocaleString('zh-CN', {
        maximumFractionDigits: Math.abs(Number(value)) < 10 ? 2 : 0
      })
      : undefined,
    dailyName: id === 'cost-line' ? '每日费用' : '每日 Token',
    cumulativeName: '区间累计'
  };

  useECharts(domRef, () => {
    if (!data || !copy) return {};
    if (isModel) return buildStackedOption(domRef.current, data.dates, modelSeries);
    return buildTrendOption(domRef.current, data.dates, metric, trendConfig);
  }, [id, data, today, theme]);

  if (!copy) return null;
  const legend = isModel ? modelSeries.map((item) => ({ id: item.id, name: item.name, color: item.color })) : [
    { id: 'daily', name: trendConfig.dailyName, color: trendConfig.barColor },
    { id: 'cumulative', name: trendConfig.cumulativeName, color: trendConfig.color, line: true }
  ];
  return (
    <UsageChartFrame
      title={copy.title}
      subtitle={copy.subtitle}
      value={metric ? (id === 'cost-line' ? formatCost(metric.total) : formatToken(metric.total)) : '—'}
      valueLabel={id === 'cost-line' ? '区间费用' : '区间 Token'}
      legend={legend}
      loading={!data}
      empty={!!metric && metric.total <= 0}
    >
      <div className="chart-container" ref={domRef} />
    </UsageChartFrame>
  );
}
