// GitHub 风格 Token 活动热力图:每日(53×7)/每周(53 列 1 行)/累计(高度条)三模式。
// 颜色用主题 primary(#74B8FC)的 5 档透明度;hover tooltip 显示日期与用量。
import React, { useEffect, useMemo, useState } from 'react';
import { getHeatmap } from '../api.js';
import { buildWeeks, colorLevel, formatToken, isoWeekKey } from '../lib/heatmap.js';

const CELL = 12;
const GAP = 2;
const LEVEL_ALPHA = [0.06, 0.18, 0.38, 0.62, 0.9];
const PROVIDER_OPTS = [
  { id: 'all', label: '全部' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'codex', label: 'Codex' },
  { id: 'kimi', label: 'Kimi' }
];

function tooltipText(date, total) {
  const d = new Date(date + 'T00:00:00');
  const label = (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return total > 0 ? (label + ' 使用了 ' + formatToken(total) + ' 个 Token') : (label + ' 无消耗');
}

export default function TokenHeatmap({ provider = 'all', year = new Date().getFullYear() }) {
  const [selProvider, setSelProvider] = useState(provider);
  const [mode, setMode] = useState('daily');
  const [data, setData] = useState({ days: {}, maxDaily: 0 });

  useEffect(() => {
    getHeatmap({ provider: selProvider, year: year }).then(setData).catch(() => {});
  }, [selProvider, year]);

  const weeks = useMemo(() => buildWeeks(year), [year]);
  const days = data.days || {};
  const maxDaily = data.maxDaily || 0;

  // 月份标签:每月 1 日所在列显示 'M月'
  const monthLabels = useMemo(() => {
    const startMs = new Date(weeks[0][0].date + 'T00:00:00').getTime();
    const labels = {};
    for (let m = 0; m < 12; m++) {
      const first = new Date(year, m, 1);
      if (first.getFullYear() !== year) continue;
      const col = Math.floor((first.getTime() - startMs) / 86400000 / 7);
      if (col >= 0 && col < weeks.length) labels[col] = (m + 1) + '月';
    }
    return labels;
  }, [weeks, year]);

  // 每周模式:按 ISO 周求和
  const weekTotals = useMemo(() => {
    const totals = {};
    Object.keys(days).forEach((date) => {
      const total = Number(days[date]) || 0;
      if (total <= 0) return;
      const key = isoWeekKey(new Date(date + 'T00:00:00'));
      totals[key] = (totals[key] || 0) + total;
    });
    return totals;
  }, [days]);
  const maxWeek = Math.max(0, ...Object.values(weekTotals));

  // 累计模式:从年初逐日累加
  const cumByDate = useMemo(() => {
    const sorted = Object.keys(days).filter((d) => d.startsWith(year + '-')).sort();
    const cum = {};
    let acc = 0;
    sorted.forEach((d) => {
      acc += Number(days[d]) || 0;
      cum[d] = acc;
    });
    return cum;
  }, [days, year]);
  const maxCum = Math.max(0, ...Object.values(cumByDate));

  // 取某列用于每周/累计的日期(该列最后一个 inYear 格)
  function lastInYearDate(col) {
    for (let r = 6; r >= 0; r--) {
      const cell = weeks[col][r];
      if (cell && cell.inYear) return cell.date;
    }
    return null;
  }

  function renderDaily() {
    return (
      <div className="heatmap-grid heatmap-grid-daily">
        {weeks.map((col, c) => (
          <div className="heatmap-col" key={c}>
            {col.map((cell, r) => {
              const total = cell && days[cell.date] ? Number(days[cell.date]) : 0;
              const level = colorLevel(total, maxDaily);
              const style = {
                width: CELL,
                height: CELL,
                background: cell && cell.inYear
                  ? 'rgba(116,184,252,' + LEVEL_ALPHA[level] + ')'
                  : 'rgba(0,0,0,0.04)'
              };
              return cell ? (
                <div key={r} className="heatmap-cell" style={style} title={tooltipText(cell.date, total)} />
              ) : <div key={r} style={{ width: CELL, height: CELL }} />;
            })}
          </div>
        ))}
      </div>
    );
  }

  function renderWeekly() {
    return (
      <div className="heatmap-grid heatmap-grid-weekly">
        {weeks.map((col, c) => {
          const date = lastInYearDate(c);
          const total = date && weekTotals[isoWeekKey(new Date(date + 'T00:00:00'))] ? weekTotals[isoWeekKey(new Date(date + 'T00:00:00'))] : 0;
          const level = colorLevel(total, maxWeek);
          return (
            <div
              key={c}
              className="heatmap-cell"
              style={{
                width: CELL + 6,
                height: CELL + 6,
                background: 'rgba(116,184,252,' + LEVEL_ALPHA[level] + ')'
              }}
              title={date ? (tooltipText(date, total) + '（该周）') : ''}
            />
          );
        })}
      </div>
    );
  }

  function renderCumulative() {
    return (
      <div className="heatmap-grid heatmap-grid-cumulative">
        {weeks.map((col, c) => {
          const date = lastInYearDate(c);
          const cum = date && cumByDate[date] ? cumByDate[date] : 0;
          const height = maxCum > 0 ? Math.max(2, Math.round((cum / maxCum) * 60)) : 2;
          return (
            <div
              key={c}
              className="heatmap-cum-bar"
              style={{ height: height, background: 'rgba(116,184,252,0.55)' }}
              title={date ? (tooltipText(date, cum) + '（累计）') : ''}
            />
          );
        })}
      </div>
    );
  }

  const monthRow = (
    <div className="heatmap-months">
      {weeks.map((col, c) => (
        <div key={c} className="heatmap-month-cell" style={{ width: CELL + (mode === 'daily' ? GAP : GAP + 6) }}>
          {monthLabels[c] || ''}
        </div>
      ))}
    </div>
  );

  return (
    <div className="heatmap-widget">
      <div className="heatmap-head">
        <span className="heatmap-title">Token 活动</span>
        <div className="heatmap-providers">
          {PROVIDER_OPTS.map((p) => (
            <button
              key={p.id}
              className={'heatmap-tab' + (selProvider === p.id ? ' active' : '')}
              onClick={() => setSelProvider(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="heatmap-modes">
        {['daily', 'weekly', 'cumulative'].map((m) => (
          <button key={m} className={'heatmap-tab' + (mode === m ? ' active' : '')} onClick={() => setMode(m)}>
            {{ daily: '每日', weekly: '每周', cumulative: '累计' }[m]}
          </button>
        ))}
        {selProvider !== 'all' && selProvider !== 'deepseek' ? <span className="heatmap-local-only">仅本机</span> : null}
      </div>
      {mode === 'daily' ? renderDaily() : null}
      {mode === 'weekly' ? renderWeekly() : null}
      {mode === 'cumulative' ? renderCumulative() : null}
      {monthRow}
      <div className="heatmap-legend">
        <span>少</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className="heatmap-legend-cell" style={{ background: 'rgba(116,184,252,' + LEVEL_ALPHA[l] + ')' }} />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}
