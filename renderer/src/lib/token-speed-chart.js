import { echartsWindowPosition } from './floating-layer.js';
import { colorWithAlpha, getSemanticChartTheme, PROVIDER_META, providerColor } from './chartTheme.js';

export { PROVIDER_META, providerColor };

export const INTERVAL_OPTIONS = Object.freeze([
  [10, '10 秒'], [20, '20 秒'], [30, '30 秒'], [60, '1 分钟'],
  [180, '3 分钟'], [300, '5 分钟'], [3600, '1 小时'], [18000, '5 小时']
]);

export const FILTER_OPTIONS = Object.freeze([
  ['all', '展示全部'], ['deepseek', 'DeepSeek'], ['codex', 'Codex'], ['kimi', 'Kimi'],
  ['dsh', 'DeepSeek Harness']
]);

const QUALITY_LABELS = Object.freeze({
  fresh: '实时',
  offline: '含离线时间',
  delayed: '更新可能延迟',
  collecting: '采集中',
  unavailable: '数据暂不可用'
});

export function formatTokenRate(value) {
  const number = Number(value) || 0;
  if (number >= 1000000) return (number / 1000000).toFixed(1) + 'M/min';
  if (number >= 1000) return (number / 1000).toFixed(1) + 'K/min';
  return Math.round(number).toLocaleString('zh-CN') + '/min';
}

export function visibleProviderIds(filter) {
  if (filter === 'all') return ['deepseek', 'codex', 'kimi', 'dsh'];
  return PROVIDER_META[filter] ? [filter] : ['deepseek', 'codex', 'kimi', 'dsh'];
}

function formatTokenDelta(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return Math.round(number).toLocaleString('zh-CN');
}

function tooltipFormatter(params) {
  const rows = Array.isArray(params) ? params : [params];
  const first = rows[0];
  const timestamp = first && first.data && first.data.value
    ? Number(first.data.value[0])
    : null;
  const header = Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
  const body = rows.map((item) => {
    const datum = item.data || {};
    const rate = datum.value && datum.value[1] !== null
      ? formatTokenRate(datum.value[1])
      : '--/min';
    const quality = QUALITY_LABELS[datum.quality] || '';
    const deltaText = formatTokenDelta(datum.deltaTokens);
    const deltaPart = deltaText === '--' ? '' : '<br/>本周期 +' + deltaText + ' Token';
    return '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'
      + item.color + '"></span> ' + item.seriesName + ': ' + rate
      + deltaPart
      + (quality ? ' · ' + quality : '');
  }).join('<br/>');
  return (header ? '<b>' + header + '</b><br/>' : '') + body;
}

function seriesFor(providerId, points, multiple, color) {
  const meta = PROVIDER_META[providerId];
  return {
    name: meta.label,
    type: 'line',
    smooth: true,
    connectNulls: false,
    showSymbol: false,
    symbol: 'none',
    sampling: 'lttb',
    lineStyle: { color, width: multiple ? 1.8 : 2.2 },
    itemStyle: { color },
    areaStyle: {
      opacity: 1,
      color: {
        type: 'linear',
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: colorWithAlpha(color, multiple ? 0.12 : 0.24) },
          { offset: 1, color: colorWithAlpha(color, 0) }
        ]
      }
    },
    emphasis: { disabled: true },
    data: (points || []).map((point) => ({
      value: [
        Number(point.time),
        Number.isFinite(Number(point.tokensPerMinute)) && point.tokensPerMinute !== null
          ? Number(point.tokensPerMinute)
          : null
      ],
      deltaTokens: Number.isFinite(Number(point.deltaTokens)) && point.deltaTokens !== null
        ? Number(point.deltaTokens)
        : null,
      quality: point.quality
    }))
  };
}

export function buildTokenSpeedOption(snapshot = {}, options = {}) {
  const ids = visibleProviderIds(snapshot.providerFilter || 'all');
  const multiple = ids.length > 1;
  const theme = options.theme || getSemanticChartTheme(options.isDark);
  const compact = options.compact === true;
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: theme.textColor, fontSize: 10 },
    grid: {
      left: compact ? 2 : 44,
      right: compact ? 2 : 10,
      top: 10,
      bottom: compact ? 2 : 24,
      containLabel: false
    },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      position: echartsWindowPosition(options.dom),
      axisPointer: { type: 'line', lineStyle: { color: theme.cursorColor } },
      backgroundColor: theme.tooltipBg,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      padding: [9, 11],
      textStyle: { color: theme.tooltipText, fontSize: 11 },
      extraCssText: 'border-radius:9px;box-shadow:var(--chart-tooltip-shadow);',
      formatter: tooltipFormatter
    },
    xAxis: {
      type: 'time',
      show: !compact,
      boundaryGap: false,
      axisPointer: { show: true },
      axisLine: { show: true, lineStyle: { color: theme.axisLineColor } },
      axisTick: { show: false },
      axisLabel: {
        show: !compact,
        color: theme.textColor,
        fontSize: 9,
        hideOverlap: true,
        formatter: (time) => new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
      },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      show: !compact,
      min: 0,
      scale: true,
      splitNumber: 3,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        show: !compact,
        color: theme.textColor,
        fontSize: 9,
        hideOverlap: true,
        formatter: (value) => formatTokenRate(value).replace('/min', '')
      },
      splitLine: { show: !compact, lineStyle: { color: theme.gridColor, type: 'dashed' } }
    },
    series: ids.map((providerId) => seriesFor(
      providerId,
      snapshot.series && snapshot.series[providerId],
      multiple,
      theme.providerColors[providerId]
    ))
  };
}
