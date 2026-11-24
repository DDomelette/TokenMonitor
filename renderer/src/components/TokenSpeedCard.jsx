import React, { useRef } from 'react';
import { SHEN } from '../shen-assets.js';
import useECharts from '../hooks/useECharts.js';
import useTokenSpeed from '../hooks/useTokenSpeed.js';
import useSemanticChartTheme from '../hooks/useSemanticChartTheme.js';
import { saveSetting } from '../api.js';
import CustomSelect from './CustomSelect.jsx';
import UsageChartFrame from './UsageChartFrame.jsx';
import {
  FILTER_OPTIONS,
  INTERVAL_OPTIONS,
  PROVIDER_META,
  buildTokenSpeedOption,
  formatTokenRate,
  visibleProviderIds
} from '../lib/token-speed-chart.js';

function SpeedIcon() {
  return (
    <svg className="token-speed-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.4 16.7a8 8 0 1 1 15.2 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M12 13.2l4.1-4.1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M5 17.5h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
  if (seconds < 60) return seconds + ' 秒';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟';
  return (seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1) + ' 小时';
}

function metricStatus(metric, intervalSeconds) {
  if (!metric || metric.status === 'unavailable') return '数据暂不可用';
  if (metric.status === 'collecting') {
    return '采集中：' + formatDuration(metric.coverageMs) + '/' + formatDuration(intervalSeconds * 1000);
  }
  if (metric.quality === 'offline') return '含离线时间';
  if (metric.quality === 'delayed') return '更新可能延迟';
  return '';
}

function metricByProvider(snapshot, providerId) {
  return (snapshot && snapshot.providers || []).find((metric) => metric.providerId === providerId) || null;
}

function formatCompactRate(value, tiny = false) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--';
  const number = Number(value);
  if (Math.abs(number) < 1000) return String(Math.round(number));
  return (tiny ? Math.round(number / 1000) : (number / 1000).toFixed(1)) + 'K';
}

const COMPACT_FILTER_LABELS = { all: '全部', deepseek: 'DS', codex: 'Codex', kimi: 'Kimi', dsh: 'Harness' };
const COMPACT_INTERVAL_LABELS = { 10: '10s', 20: '20s', 30: '30s', 60: '1m', 180: '3m', 300: '5m', 3600: '1h', 18000: '5h' };

export default function TokenSpeedCard() {
  const chartRef = useRef(null);
  const snapshot = useTokenSpeed();
  const theme = useSemanticChartTheme();
  const providerFilter = snapshot && snapshot.providerFilter || 'all';
  const intervalSeconds = snapshot && snapshot.intervalSeconds || 30;
  const providerIds = visibleProviderIds(providerFilter);

  useECharts(chartRef, () => buildTokenSpeedOption(snapshot || {
    providerFilter,
    series: {}
  }, {
    theme,
    compact: !!chartRef.current && chartRef.current.clientWidth < 220,
    dom: chartRef.current
  }), [snapshot, theme]);

  function updateFilter(value) {
    saveSetting('data.tokenSpeed.providerFilter', value).catch(() => {});
  }

  function updateInterval(value) {
    saveSetting('data.tokenSpeed.intervalSeconds', Number(value)).catch(() => {});
  }

  const controls = (
    <div className="token-speed-controls">
      <CustomSelect
        ariaLabel="展示平台"
        value={providerFilter}
        options={FILTER_OPTIONS}
        onChange={updateFilter}
        compactLabels={COMPACT_FILTER_LABELS}
      />
      <CustomSelect
        ariaLabel="统计周期"
        value={intervalSeconds}
        options={INTERVAL_OPTIONS}
        onChange={updateInterval}
        compactLabels={COMPACT_INTERVAL_LABELS}
      />
    </div>
  );

  const legend = (
    <div className="usage-chart-legend token-speed-legends" aria-label="平台实时速率">
      {providerIds.map((providerId) => {
        const meta = PROVIDER_META[providerId];
        const metric = metricByProvider(snapshot, providerId);
        const rate = metric && metric.tokensPerMinute !== null
          ? formatTokenRate(metric.tokensPerMinute)
          : '--/min';
        const deltaValid = metric && metric.deltaTokens !== null
          && Number.isFinite(Number(metric.deltaTokens));
        const delta = deltaValid
          ? Math.round(Number(metric.deltaTokens)).toLocaleString('zh-CN')
          : null;
        const status = metricStatus(metric, intervalSeconds);
        return (
          <div className="usage-chart-legend-item token-speed-legend" key={providerId}>
            <span
              className="usage-chart-legend-mark line token-speed-dot"
              style={{ backgroundColor: theme.providerColors[providerId] }}
              aria-hidden="true"
            />
            <span className="token-speed-provider" title={meta.label}>{meta.shortLabel || meta.label}</span>
            <strong title={meta.label + '：' + rate} aria-label={meta.label + '：' + rate}>
              <span className="token-speed-rate-full">{rate}</span>
              <span className="token-speed-rate-compact" aria-hidden="true">{formatCompactRate(metric && metric.tokensPerMinute)}</span>
              <span className="token-speed-rate-tiny" aria-hidden="true">{formatCompactRate(metric && metric.tokensPerMinute, true)}</span>
            </strong>
            {providerFilter !== 'all' && delta !== null && <span className="token-speed-delta">本周期 +{delta} Token</span>}
            {status && <span className="token-speed-status">{status}</span>}
          </div>
        );
      })}
    </div>
  );

  return (
    <section className="token-speed-card" aria-label="Token 消耗速度">
      <img className="shen-deco shen-lying" src={SHEN.lying} alt="" aria-hidden="true" />
      <div className="shen-deco shen-caption">主人今天用了好多 Token 呀…</div>
      <UsageChartFrame
        title={<span className="token-speed-title"><SpeedIcon /><span>Token 消耗速度</span></span>}
        subtitle="实时速率 · 滑动时间窗"
        actions={controls}
        legend={legend}
        loading={!snapshot}
      >
        <div className="chart-container token-speed-chart" ref={chartRef} />
      </UsageChartFrame>
    </section>
  );
}
