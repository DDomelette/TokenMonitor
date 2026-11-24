// 全平台每日 Token：与其他统计图共享日期、周期、聚合口径与平台注册色。
import React, { useRef } from 'react';
import useECharts from '../hooks/useECharts.js';
import useBeijingDayKey from '../hooks/useBeijingDayKey.js';
import useSemanticChartTheme from '../hooks/useSemanticChartTheme.js';
import { useUsageCharts } from '../store.js';
import { useChartRange } from './ChartRange.jsx';
import UsageChartFrame from './UsageChartFrame.jsx';
import { buildStackedOption, formatToken } from './ChartWidget.jsx';

export default function ProviderBar() {
  const domRef = useRef(null);
  const today = useBeijingDayKey();
  const theme = useSemanticChartTheme();
  const { days } = useChartRange();
  const data = useUsageCharts({ days, today });
  const series = data ? data.providers.map((provider) => Object.assign({}, provider, {
    color: theme.providerColors[provider.id]
  })) : [];

  useECharts(domRef, () => {
    if (!data) return {};
    return buildStackedOption(domRef.current, data.dates, series);
  }, [data, today, theme]);

  return (
    <UsageChartFrame
      title="全平台 Token 消耗"
      subtitle="按平台堆叠 · 每日"
      value={data ? formatToken(data.allTokens.total) : '—'}
      valueLabel="区间 Token"
      legend={series.map((item) => ({ id: item.id, name: item.name, color: item.color }))}
      loading={!data}
      empty={!!data && data.allTokens.total <= 0}
    >
      <div className="chart-container" ref={domRef} />
    </UsageChartFrame>
  );
}
