import React from 'react';

export function ChartLegend({ items = [] }) {
  if (!items.length) return null;
  return (
    <div className="usage-chart-legend" aria-label="图例">
      {items.map((item) => (
        <span className="usage-chart-legend-item" key={item.id || item.name} title={item.name}>
          <span
            className={'usage-chart-legend-mark' + (item.line ? ' line' : '')}
            style={{ backgroundColor: item.color }}
            aria-hidden="true"
          />
          <span className="usage-chart-legend-name">{item.name}</span>
        </span>
      ))}
    </div>
  );
}

export default function UsageChartFrame({
  title,
  subtitle,
  value,
  valueLabel,
  legend,
  actions,
  loading,
  empty,
  children
}) {
  return (
    <div className="usage-chart-frame">
      <header className="usage-chart-header">
        <div className="usage-chart-heading">
          <h3 className="usage-chart-title">{title}</h3>
          <p className="usage-chart-subtitle">{subtitle}</p>
        </div>
        {actions || (
          <div className="usage-chart-kpi">
            <strong className="usage-chart-value">{value}</strong>
            <span className="usage-chart-value-label">{valueLabel}</span>
          </div>
        )}
      </header>
      {Array.isArray(legend) ? <ChartLegend items={legend} /> : legend}
      <div className="usage-chart-body">
        {children}
        {loading ? <div className="usage-chart-state">正在读取用量数据…</div> : null}
        {!loading && empty ? <div className="usage-chart-state">当前周期暂无数据</div> : null}
      </div>
    </div>
  );
}
