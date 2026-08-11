import { echartsWindowPosition } from './floating-layer.js';

export const PROVIDER_META = Object.freeze({
  deepseek: { label: 'DeepSeek', color: '#6E94F5' },
  codex: { label: 'Codex', color: '#F2A05C' },
  kimi: { label: 'Kimi', color: '#4ECB94' }
});

export const INTERVAL_OPTIONS = Object.freeze([
  [10, '10 秒'], [20, '20 秒'], [30, '30 秒'], [60, '1 分钟'],
  [180, '3 分钟'], [300, '5 分钟'], [3600, '1 小时'], [18000, '5 小时']
]);

export const FILTER_OPTIONS = Object.freeze([
  ['all', '展示全部'], ['deepseek', 'DeepSeek'], ['codex', 'Codex'], ['kimi', 'Kimi']
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
  if (filter === 'all') return ['deepseek', 'codex', 'kimi'];
  return PROVIDER_META[filter] ? [filter] : ['deepseek', 'codex', 'kimi'];
}

function rgba(hex, alpha) {
  const value = hex.replace('#', '');
  const red = parseInt(value.slice(0, 2), 16);
  const green = parseInt(value.slice(2, 4), 16);
  const blue = parseInt(value.slice(4, 6), 16);
  return `rgba(${red},${green},${blue},${alpha})`;
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
    return '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:'
      + item.color + '"></span> ' + item.seriesName + ': ' + rate
      + '<br/>本周期 +' + formatTokenDelta(datum.deltaTokens) + ' Token'
      + (quality ? ' · ' + quality : '');
  }).join('<br/>');
  return (header ? '<b>' + header + '</b><br/>' : '') + body;
}

function seriesFor(providerId, points, multiple) {
  const meta = PROVIDER_META[providerId];
  const opacity = multiple ? 0.05 : 0.16;
  return {
    name: meta.label,
    type: 'line',
    smooth: true,
    connectNulls: false,
    showSymbol: false,
    symbol: 'none',
    sampling: 'lttb',
    lineStyle: {
      color: meta.color,
      width: multiple ? 1.8 : 2.2
    },
    itemStyle: { color: meta.color },
    areaStyle: {
      opacity,
      color: {
        type: 'linear',
        x: 0,
        y: 0,
        x2: 0,
        y2: 1,
        colorStops: [
          { offset: 0, color: rgba(meta.color, multiple ? 0.42 : 0.62) },
          { offset: 1, color: rgba(meta.color, 0) }
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
  const isDark = options.isDark === true;
  return {
    animation: false,
    backgroundColor: 'transparent',
    grid: {
      left: options.compact ? 2 : 6,
      right: options.compact ? 2 : 6,
      top: 5,
      bottom: 2,
      containLabel: false
    },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      position: echartsWindowPosition(options.dom),
      axisPointer: { type: 'line', lineStyle: { color: isDark ? '#6B7280' : '#9CA3AF' } },
      backgroundColor: isDark ? 'rgba(30,32,38,0.96)' : 'rgba(255,255,255,0.97)',
      borderColor: isDark ? '#3A3C45' : '#E5E7EB',
      textStyle: { color: isDark ? '#E5E7EB' : '#1A1A2E', fontSize: 11 },
      formatter: tooltipFormatter
    },
    xAxis: {
      type: 'time',
      show: false,
      boundaryGap: false,
      axisPointer: { show: true }
    },
    yAxis: {
      type: 'value',
      show: false,
      min: 0,
      scale: true
    },
    series: ids.map((providerId) => seriesFor(
      providerId,
      snapshot.series && snapshot.series[providerId],
      multiple
    ))
  };
}
