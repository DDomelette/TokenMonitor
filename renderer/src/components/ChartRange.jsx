import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useUsageCharts } from '../store.js';
import useBeijingDayKey from '../hooks/useBeijingDayKey.js';
import { getSettings, on, send } from '../api.js';

export const RANGE_OPTIONS = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' }
];
const STORAGE_KEY = 'token-monitor.chart-range-days';
const ChartRangeContext = createContext(null);

function initialDays() {
  try {
    const saved = Number(window.localStorage.getItem(STORAGE_KEY));
    return RANGE_OPTIONS.some((option) => option.days === saved) ? saved : 30;
  } catch (error) {
    return 30;
  }
}

export function ChartRangeProvider({ children }) {
  const [days, setDays] = useState(initialDays);
  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, String(days)); } catch (error) { /* 私密模式下仅不持久化 */ }
  }, [days]);
  const value = useMemo(() => ({ days, setDays }), [days]);
  return <ChartRangeContext.Provider value={value}>{children}</ChartRangeContext.Provider>;
}

export function useChartRange() {
  const value = useContext(ChartRangeContext);
  return value || { days: 30, setDays: () => {} };
}

function shortDate(value) {
  return value ? value.slice(5).replace('-', '/') : '';
}

export function ChartRangeToolbar() {
  const { days, setDays } = useChartRange();
  const today = useBeijingDayKey();
  const data = useUsageCharts({ days, today });
  const [historyDays, setHistoryDays] = useState(null);
  useEffect(() => {
    const readRetention = (settings) => {
      const value = Number(settings && settings.data && settings.data.historyDays);
      setHistoryDays(Number.isInteger(value) && value > 0 ? value : null);
    };
    getSettings().then(readRetention).catch(() => {});
    return on('settings:loaded', readRetention);
  }, []);
  const needsHistory = Number.isInteger(historyDays) && historyDays < days;
  return (
    <div className="chart-range-toolbar" aria-label="统计图表周期设置">
      <div className="chart-range-copy">
        <span className="chart-range-title">统计周期</span>
        <span className="chart-range-source">统一日聚合 · 北京时间</span>
      </div>
      <div className="chart-range-actions">
        {data && data.range ? (
          <span className="chart-range-dates">{shortDate(data.range.start)} — {shortDate(data.range.end)}</span>
        ) : null}
        <div className="chart-range-control" role="group" aria-label="选择统计周期">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.days}
              type="button"
              className={'chart-range-option' + (days === option.days ? ' active' : '')}
              aria-pressed={days === option.days}
              onClick={() => setDays(option.days)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {needsHistory ? (
        <button
          type="button"
          className="chart-range-retention"
          onClick={() => send('open:settings')}
          title="扩展历史保留天数后，可在设置中同步历史数据"
        >
          历史仅保留 {historyDays} 天 · 去设置扩展
        </button>
      ) : null}
    </div>
  );
}
