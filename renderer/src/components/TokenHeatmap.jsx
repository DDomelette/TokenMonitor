// GitHub 风格 Token 活动热力图:每日(53×7)/每周·累计三模式共用同一网格。
// 每周/累计只是在每日网格基础上改变被上色的格子(列内从底向上按量填色)。
// 颜色用主题 primary(#74B8FC)的 5 档透明度;hover tooltip 显示日期与用量。
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getHeatmap, onProvidersChanged } from '../api.js';
import { buildSundayWeekTotals, buildWeeks, blockCount, colorLevel, formatToken, sundayWeekKey } from '../lib/heatmap.js';
import {
  createLocalCalendarClock,
  findDayColumn,
  localDayKey,
  resolveHeatmapYear
} from '../lib/local-calendar-clock.js';

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
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return month + '月' + day + '日';
}

export default function TokenHeatmap({ provider = 'all', year: requestedYear }) {
  const [clockDate, setClockDate] = useState(() => new Date());
  const year = resolveHeatmapYear(requestedYear, clockDate);
  const [selProvider, setSelProvider] = useState(provider);
  const [mode, setMode] = useState('daily');
  const [data, setData] = useState({ days: {}, maxDaily: 0 });
  const [boxWidth, setBoxWidth] = useState(0);
  const [tip, setTip] = useState(null);
  const rootRef = useRef(null);
  const tipRef = useRef(null);
  const tipTimers = useRef({ settle: null, hide: null, fade: null });
  const pendingTip = useRef(null);
  const lastTipX = useRef(0);

  useEffect(() => {
    const clock = createLocalCalendarClock({
      onChange: (date) => setClockDate(date)
    });
    return () => clock.stop();
  }, []);

  useEffect(() => {
    getHeatmap({ provider: selProvider, year: year }).then(setData).catch(() => {});
  }, [selProvider, year]);

  // 手动刷新/定时轮询成功后重取,保持与状态栏"刷新时间"同步
  useEffect(() => {
    return onProvidersChanged(() => {
      getHeatmap({ provider: selProvider, year: year }).then(setData).catch(() => {});
    });
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

  // 自适应容器宽度:只保留最近若干周(结尾对齐本周);宽度足够时显示全年。
  // 三种模式共用同一网格,列宽一致,避免空周列塌缩导致月份错位。
  const colWidth = CELL + GAP;
  const availWidth = boxWidth > 0 ? boxWidth - 4 : window.innerWidth - 52;
  const maxCols = Math.max(4, Math.floor(availWidth / colWidth));
  const todayKey = localDayKey(clockDate);
  const todayCol = useMemo(
    () => findDayColumn(weeks, todayKey),
    [weeks, todayKey]
  );
  const end = maxCols >= weeks.length ? weeks.length : Math.min(weeks.length, todayCol + 1);
  const start = maxCols >= weeks.length ? 0 : Math.max(0, end - maxCols);
  const visibleWeeks = useMemo(() => weeks.slice(start, end), [weeks, start, end]);

  // 月份标签:每月 1 日所在列显示 'M月'
  const monthLabels = useMemo(() => {
    const labels = {};
    for (let m = 1; m <= 12; m++) {
      const firstDay = year + '-' + String(m).padStart(2, '0') + '-01';
      const col = weeks.findIndex((week) => week.some((cell) => cell.date === firstDay));
      if (col >= 0 && col < weeks.length) labels[col] = m + '月';
    }
    return labels;
  }, [weeks, year]);

  // 每周模式:按当前可视列的周日至周六区间求和
  const weekTotals = useMemo(() => buildSundayWeekTotals(days), [days]);
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
  // 初始位置用估计半宽钳制,渲染后由 useLayoutEffect 按实测宽度二次校正(向窗口中间靠拢)
  const clampTipX = (x) => Math.max(104, Math.min(window.innerWidth - 104, x));
  // GitHub 贡献图式悬停意图:鼠标在格子上停稳 SHOW_DELAY 后才加载浮层;
  // 快速划过时定时器不断被取消,浮层不会出现,信息不闪烁。
  const SHOW_DELAY = 220;
  const HIDE_DELAY = 120;
  const FADE_OUT = 320;
  const clearTimer = (k) => {
    if (tipTimers.current[k]) {
      clearTimeout(tipTimers.current[k]);
      tipTimers.current[k] = null;
    }
  };
  const cancelTipHide = () => ['hide', 'fade'].forEach(clearTimer);
  const showTip = (e, date, overrideLines, headText) => {
    if (!date) return;
    ['settle', 'hide', 'fade'].forEach(clearTimer);
    lastTipX.current = e.clientX;
    const r = e.currentTarget.getBoundingClientRect();
    const below = r.top < 140;
    pendingTip.current = {
      x: clampTipX(r.left + r.width / 2),
      y: below ? r.bottom + 6 : r.top - 6,
      below: below,
      date: date,
      overrideLines: overrideLines || null,
      headText: headText || null
    };
    // 换格子时旧浮层立即开始淡出(内容不原地替换),新内容停稳后才淡入
    setTip((prev) => (prev && !prev.fading ? Object.assign({}, prev, { fading: true }) : prev));
    tipTimers.current.settle = setTimeout(() => {
      tipTimers.current.settle = null;
      if (!pendingTip.current) return;
      setTip(Object.assign({}, pendingTip.current, { x: clampTipX(lastTipX.current) }));
    }, SHOW_DELAY);
  };
  // 格子内跟随鼠标横移,配合 CSS transition 在格子间平滑滑动
  const moveTip = (e) => {
    lastTipX.current = e.clientX;
    setTip((prev) => (prev && !prev.fading ? Object.assign({}, prev, { x: clampTipX(e.clientX) }) : prev));
  };
  const hideTip = () => {
    pendingTip.current = null;
    clearTimer('settle');
    cancelTipHide();
    tipTimers.current.hide = setTimeout(() => {
      tipTimers.current.hide = null;
      setTip((prev) => (prev ? Object.assign({}, prev, { fading: true }) : prev));
      tipTimers.current.fade = setTimeout(() => {
        tipTimers.current.fade = null;
        setTip(null);
      }, FADE_OUT);
    }, HIDE_DELAY);
  };

  // 实测浮层宽度:内容(缓存明细)会把浮层撑到 260px+,估计值钳不紧,
  // 这里按 offsetWidth 把中心点夹回窗口内,与 echarts confine 行为一致
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const half = el.offsetWidth / 2 + 8;
    const x = Math.max(half, Math.min(window.innerWidth - half, tip.x));
    if (Math.abs(x - tip.x) > 0.5) el.style.left = x + 'px';
  }, [tip]);

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

  // 每周/累计:与每日共用同一网格,列内按总量从底向上填色 N 格,
  // N ∝ 值(scale = 列最大值 / 7,即满列 7 格)。未填的 inYear 格用最浅档。
  function renderStacked(valueForCol, headTextForCol, scale) {
    return (
      <div className="heatmap-grid heatmap-grid-daily">
        {visibleWeeks.map((col, i) => {
          const c = start + i;
          const blocks = blockCount(valueForCol(c, col), scale);
          const date = lastInYearDate(c);
          const headText = headTextForCol(c, col);
          return (
            <div className="heatmap-col" key={c}>
              {col.map((cell, r) => {
                if (!cell) return <div key={r} style={{ width: CELL, height: CELL }} />;
                // 从底向上数第 N 个 inYear 格上色(只填本年格,跨年格保持底色)
                const inYearBelow = col.slice(r).filter((x) => x && x.inYear).length;
                const filled = cell.inYear && inYearBelow <= blocks;
                const style = {
                  width: CELL,
                  height: CELL,
                  background: !cell.inYear
                    ? 'rgba(0,0,0,0.04)'
                    : filled
                      ? 'rgba(116,184,252,0.55)'
                      : 'rgba(116,184,252,' + LEVEL_ALPHA[0] + ')'
                };
                return (
                  <div
                    key={r}
                    className="heatmap-cell"
                    style={style}
                    onMouseEnter={(e) => showTip(e, date, null, headText)}
                    onMouseMove={moveTip} onMouseLeave={hideTip}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  function renderWeekly() {
    return renderStacked(
      (c, col) => {
        const weekKey = col[0] ? sundayWeekKey(col[0].date) : null;
        return weekKey ? weekTotals[weekKey] || 0 : 0;
      },
      (c, col) => {
        const weekKey = col[0] ? sundayWeekKey(col[0].date) : null;
        return weekKey ? dateLabel(weekKey) + ' 当周使用了' : null;
      },
      maxWeek > 0 ? maxWeek / 7 : 0
    );
  }

  function renderCumulative() {
    return renderStacked(
      (c) => {
        const date = lastInYearDate(c);
        return date && cumByDate[date] ? cumByDate[date] : 0;
      },
      (c) => {
        const date = lastInYearDate(c);
        return date ? '截至 ' + date.slice(0, 4) + '年' + dateLabel(date) + ' 当周累计使用' : null;
      },
      maxCum > 0 ? maxCum / 7 : 0
    );
  }

  const monthRow = (
    <div className="heatmap-months">
      {visibleWeeks.map((col, i) => {
        const c = start + i;
        const label = monthLabels[c];
        return (
          <div key={c} className="heatmap-month-cell" style={{ width: CELL + GAP }}>
            {label ? <span className={'heatmap-month-text' + (i === visibleWeeks.length - 1 ? ' last' : '')}>{label}</span> : ''}
          </div>
        );
      })}
    </div>
  );

  // 浮层头部右侧的总量:每日=当日合计;每周=所在可视列合计;累计=年初至该日累计
  function tipTotal(date) {
    if (mode === 'weekly') {
      const key = sundayWeekKey(date);
      return key ? weekTotals[key] || 0 : 0;
    }
    if (mode === 'cumulative') return cumByDate[date] || 0;
    return Number(days[date]) || 0;
  }

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
      {tip
        // portal 到 body:留在模块内会被卡片的 overflow:hidden 裁剪,
        // 且 backdrop-filter 使 fixed 以卡片为包含块,撑大 scrollHeight
        // 触发 Dashboard fitItems 自动撑高模块(下边框自行向下扩张)
        ? createPortal(
            <div ref={tipRef} className={'heatmap-tooltip' + (tip.below ? ' below' : '') + (tip.fading ? ' fading' : '')} style={{ left: tip.x, top: tip.y }}>
              <div className="heatmap-tooltip-head">
                <span className="heatmap-tooltip-date">{tip.headText || dateLabel(tip.date)}</span>
                <span className="heatmap-tooltip-total">{formatToken(tipTotal(tip.date))} Token</span>
              </div>
              {(tip.overrideLines || tipLines(tip.date)).map((l, i) => (
                <div key={i} className="heatmap-tooltip-row">
                  <span className="heatmap-tooltip-label">{l.label}</span>
                  <span className="heatmap-tooltip-value">{l.value}</span>
                </div>
              ))}
              {!(tip.overrideLines || tipLines(tip.date)).length ? <div className="heatmap-tooltip-row">无消耗</div> : null}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
