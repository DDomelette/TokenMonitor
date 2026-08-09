import React, { useRef } from 'react';
import useECharts from '../hooks/useECharts.js';
import useTokenSpeed from '../hooks/useTokenSpeed.js';
import { saveSetting } from '../api.js';
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

export default function TokenSpeedCard() {
  const chartRef = useRef(null);
  const snapshot = useTokenSpeed();
  const providerFilter = snapshot && snapshot.providerFilter || 'all';
  const intervalSeconds = snapshot && snapshot.intervalSeconds || 30;
  const providerIds = visibleProviderIds(providerFilter);

  useECharts(chartRef, () => buildTokenSpeedOption(snapshot || {
    providerFilter,
    series: {}
  }, {
    isDark: document.body.classList.contains('dark'),
    compact: !!chartRef.current && chartRef.current.clientWidth < 220
  }), [snapshot]);

  function updateFilter(event) {
    saveSetting('data.tokenSpeed.providerFilter', event.target.value).catch(() => {});
  }

  function updateInterval(event) {
    saveSetting('data.tokenSpeed.intervalSeconds', Number(event.target.value)).catch(() => {});
  }

  return (
    <section className="token-speed-card" aria-label="Token 消耗速度">
      <div className="token-speed-header">
        <div className="token-speed-title"><SpeedIcon /><span>Token 消耗速度</span></div>
        <div className="token-speed-controls">
          <label>
            <select className="token-speed-select" aria-label="展示平台" value={providerFilter} onChange={updateFilter}>
              {FILTER_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <select className="token-speed-select" aria-label="统计周期" value={intervalSeconds} onChange={updateInterval}>
              {INTERVAL_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
      </div>

      <div className="token-speed-legends">
        {providerIds.map((providerId) => {
          const meta = PROVIDER_META[providerId];
          const metric = metricByProvider(snapshot, providerId);
          const rate = metric && metric.tokensPerMinute !== null
            ? formatTokenRate(metric.tokensPerMinute)
            : '--/min';
          const delta = metric && metric.deltaTokens !== null
            ? Math.round(metric.deltaTokens).toLocaleString('zh-CN')
            : '--';
          const status = metricStatus(metric, intervalSeconds);
          return (
            <div className="token-speed-legend" key={providerId}>
              <span className="token-speed-dot" style={{ backgroundColor: meta.color }} />
              <span className="token-speed-provider">{meta.label}</span>
              <strong>{rate}</strong>
              {providerFilter !== 'all' && <span className="token-speed-delta">本周期 +{delta} Token</span>}
              {status && <span className="token-speed-status">{status}</span>}
            </div>
          );
        })}
      </div>

      <div className="token-speed-chart" ref={chartRef} />
    </section>
  );
}
