// GitHub 风格 Token 活动热力图:每日(53×7)/每周(53 列 1 行)/累计(高度条)三模式。
// 颜色用主题 primary(#74B8FC)的 5 档透明度;hover tooltip 显示日期与用量。
import React, { useEffect, useMemo, useRef, useState } from 'react';
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

function dateLabel(date) {
  const d = new Date(date + 'T00:00:00');
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

export default function TokenHeatmap({ provider = 'all', year = new Date().getFullYear() }) {
  const [selProvider, setSelProvider] = useState(provider);
  const [mode, setMode] = useState('daily');
  const [data, setData] = useState({ days: {}, maxDaily: 0 });
  const [boxWidth, setBoxWidth] = useState(0);
  const [tip, setTip] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => {
    getHeatmap({ provider: selProvider, year: year }).then(setData).catch(() => {});
  }, [selProvider, year]);

  // 以容器宽度为准(grid 内板块可被拖窄),而不是窗口宽度
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setBoxWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const weeks = useMemo(() => buildWeeks(year), [year]);
  const days = data.days || {};
  const maxDaily = data.maxDaily || 0;

  // 自适应容器宽度:只保留最近若干周(结尾对齐本周);宽度足够时显示全年
  const colWidth = mode === 'weekly' ? CELL + GAP + 6 : CELL + GAP;
  const availWidth = boxWidth > 0 ? boxWidth - 4 : window.innerWidth - 52;
  const maxCols = Math.max(4, Math.floor(availWidth / colWidth));
  const todayCol = useMemo(() => {
    const now = new Date();
    const iso = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    for (let c = 0; c < weeks.length; c++) {
      if (weeks[c].some((cell) => cell && cell.date === iso)) return c;
    }
    return weeks.length - 1;
  }, [weeks]);
  const end = maxCols >= weeks.length ? weeks.length : Math.min(weeks.length, todayCol + 1);
  const start = maxCols >= weeks.length ? 0 : Math.max(0, end - maxCols);
  const visibleWeeks = useMemo(() => weeks.slice(start, end), [weeks, start, end]);

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

  // 自定义悬停提示(原生 title 在透明窗口不显示;内容:日期 + 平台/模型明细)
  const clampTipX = (x) => Math.max(104, Math.min(window.innerWidth - 104, x));
  const showTip = (e, date, overrideLines) => {
    if (!date) return;
    const r = e.currentTarget.getBoundingClientRect();
    const below = r.top < 140;
    setTip({
      // 浮层最宽约 200px:钳制中心点,防止右/左边缘被窗口裁掉
      x: clampTipX(r.left + r.width / 2),
      y: below ? r.bottom + 6 : r.top - 6,
      below: below,
      date: date,
      overrideLines: overrideLines || null
    });
  };
  // 格子内跟随鼠标横移,配合 CSS transition 在格子间平滑滑动
  const moveTip = (e) => {
    setTip((prev) => (prev ? Object.assign({}, prev, { x: clampTipX(e.clientX) }) : prev));
  };
  const hideTip = () => setTip(null);

  function tipLines(date) {
    const det = data.details || {};
    const byProvider = det.byProvider || {};
    const cachedByProvider = det.cachedByProvider || {};
    const total = Number(days[date]) || 0;
    const lines = [];
    const cachedSuffix = (pid) => {
      const c = cachedByProvider[pid] && Number(cachedByProvider[pid][date]);
      return c > 0 ? '（缓存 ' + formatToken(c) + '）' : '';
    };
    if (selProvider === 'all') {
      PROVIDER_OPTS.filter((p) => p.id !== 'all').forEach((p) => {
        const t = byProvider[p.id] && Number(byProvider[p.id][date]);
        if (t > 0) lines.push({ label: p.label, value: formatToken(t) + ' Token' + cachedSuffix(p.id) });
      });
    } else if (selProvider === 'deepseek') {
      if (total > 0) lines.push({ label: 'DeepSeek 合计', value: formatToken(total) + ' Token' + cachedSuffix('deepseek') });
      ((det.deepseekModels || {})[date] || []).forEach((m) => {
        if (m.tokens > 0) lines.push({ label: m.model, value: formatToken(m.tokens) + ' Token' });
      });
    } else {
      const p = PROVIDER_OPTS.find((o) => o.id === selProvider);
      if (total > 0) lines.push({ label: p ? p.label : selProvider, value: formatToken(total) + ' Token' + cachedSuffix(selProvider) });
    }
    return lines;
  }

  function renderDaily() {
    return (
      <div className="heatmap-grid heatmap-grid-daily">
        {visibleWeeks.map((col, i) => (
          <div className="heatmap-col" key={start + i}>
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
                <div
                  key={r}
                  className="heatmap-cell"
                  style={style}
                  onMouseEnter={(e) => showTip(e, cell.date)}
                  onMouseMove={moveTip} onMouseLeave={hideTip}
                />
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
        {visibleWeeks.map((col, i) => {
          const c = start + i;
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
              onMouseEnter={(e) => showTip(e, date)}
              onMouseMove={moveTip} onMouseLeave={hideTip}
            />
          );
        })}
      </div>
    );
  }

  function renderCumulative() {
    return (
      <div className="heatmap-grid heatmap-grid-cumulative">
        {visibleWeeks.map((col, i) => {
          const c = start + i;
          const date = lastInYearDate(c);
          const cum = date && cumByDate[date] ? cumByDate[date] : 0;
          const height = maxCum > 0 ? Math.max(2, Math.round((cum / maxCum) * 60)) : 2;
          return (
            <div
              key={c}
              className="heatmap-cum-bar"
              style={{ height: height, background: 'rgba(116,184,252,0.55)' }}
              onMouseEnter={(e) => showTip(e, date, cum > 0 ? [{ label: '累计消耗', value: formatToken(cum) + ' Token' }] : null)}
              onMouseMove={moveTip} onMouseLeave={hideTip}
            />
          );
        })}
      </div>
    );
  }

  const monthRow = (
    <div className="heatmap-months">
      {visibleWeeks.map((col, i) => {
        const c = start + i;
        return (
          <div key={c} className="heatmap-month-cell" style={{ width: CELL + (mode === 'daily' ? GAP : GAP + 6) }}>
            {monthLabels[c] || ''}
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="heatmap-widget" ref={rootRef}>
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
      {tip ? (
        <div className={'heatmap-tooltip' + (tip.below ? ' below' : '')} style={{ left: tip.x, top: tip.y }}>
          <div className="heatmap-tooltip-date">{dateLabel(tip.date)}</div>
          {(tip.overrideLines || tipLines(tip.date)).map((l, i) => (
            <div key={i} className="heatmap-tooltip-row">
              <span className="heatmap-tooltip-label">{l.label}</span>
              <span className="heatmap-tooltip-value">{l.value}</span>
            </div>
          ))}
          {!(tip.overrideLines || tipLines(tip.date)).length ? <div className="heatmap-tooltip-row">无消耗</div> : null}
        </div>
      ) : null}
    </div>
  );
}
