// 迷你模式视图:Codex/Kimi 主额度窗口统一由 QuotaRing 显示单环、两段或三段;
// DeepSeek 与 DeepSeek Harness(dsh)复用同一组件显示 DeepSeek 余额(金额环 100% = ¥100,环内为金额),
// 右侧为各平台 Token 消耗速度(与速度卡片同源:tokensPerMinute + formatTokenRate)。
// 行顺序可在设置窗口调整(window.miniRowOrder),按每页两行分页;
// 行数超出一屏时向左滚动播报:离场渐隐由慢到快,播完后下一页才从右入场(由快到慢),两段不重合。
// 顶部栏含放大/最小化/关闭三钮;整窗为系统原生拖拽区(拖动顺滑不依赖 JS);
// 贴边吸附收起后切换为竖条速度柱(柱子越高速度越快),竖条上双击恢复完整模式。
import React, { useEffect, useRef, useState } from 'react';
import { useProviders, useDashboard } from '../store.js';
import useTokenSpeed from '../hooks/useTokenSpeed.js';
import { on, send, toggleMini, getEdgeDockState, getSettings } from '../api.js';
import { PROVIDER_META, formatTokenRate, providerColor } from '../lib/token-speed-chart.js';
import { quotaSegments } from '../lib/quota-ring.mjs';
import QuotaRing from './QuotaRing.jsx';
import { SHEN } from '../shen-assets.js';
import '../../../src/shared/mini-row-order.js';

// 行分页滚动播报:一屏两行,超出后定时向左滚动;
// 离场向左渐隐、由慢到快(ease-in),入场从右滑入渐显、由快到慢(ease-out)。
const { PROVIDER_IDS: MINI_ROW_PIDS, parseRowOrder } = globalThis.MiniRowOrder;
const PAGE_SIZE = 2;
const PAGE_COUNT = Math.ceil(MINI_ROW_PIDS.length / PAGE_SIZE);
const ROTATE_MS = 4000;
const ANIM_MS = 620;

// 金额圆环:100% = ¥100,环内数字为金额(纯数字,空间只容得下 4-5 个字符)
const RING_FULL_YUAN = 100;
function amountFrac(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(1, n / RING_FULL_YUAN);
}
function amountLabel(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return '--';
  return String(n >= 100 ? Math.round(n) : Number(n.toFixed(1)));
}

function RowInfo({ pid, rate }) {
  const meta = PROVIDER_META[pid];
  return (
    <div className="mini-row-info">
      <span className="mini-dot" style={{ background: providerColor(pid) }} />
      <span className="mini-name">{meta.label}</span>
      <span className="mini-speed">{rate}</span>
    </div>
  );
}

// 贴边收起后的竖条:每个平台一条胶囊形轨道(上下半圆端,透明底透出亚克力),
// 底部彩色填充高度 ∝ 当前速度;固定刻度 1000.0K/min = 100%,超出按满格计。
// 注意可见区在窗口的"靠屏内侧":右缘停靠时窗口向右滑出,屏上露出的是窗口的
// 左 12px,竖条必须画在窗口左侧;左缘停靠反之;顶缘收起露出窗口底部。
function SpeedStrip({ edge, rates, onRestore }) {
  const FULL_SCALE = 1000000; // 1000.0K/min = 100%
  const values = MINI_ROW_PIDS.map((pid) => Number(rates[pid]) || 0);
  const horizontal = edge === 'top';
  const side = edge === 'right' ? 'left' : edge === 'left' ? 'right' : 'top';
  return (
    <div className={'mini-strip mini-strip-' + side} onClick={onRestore}>
      {MINI_ROW_PIDS.map((pid, i) => {
        const pct = Math.min(100, Math.round((values[i] / FULL_SCALE) * 100)) + '%';
        return (
          <div key={pid} className="mini-strip-bar">
            <div
              className="mini-strip-fill"
              style={horizontal
                ? { background: providerColor(pid), width: pct }
                : { background: providerColor(pid), height: pct }}
            />
          </div>
        );
      })}
    </div>
  );
}

export default function MiniView() {
  const providers = useProviders();
  const dashboard = useDashboard('deepseek');
  const speed = useTokenSpeed();
  const [dock, setDock] = useState(null);
  const lastClickAt = useRef(0);
  // 行顺序:跟随设置 window.miniRowOrder(设置窗口可上下移动调整)
  const [rowOrder, setRowOrder] = useState(MINI_ROW_PIDS);
  // 翻页状态:page 为当前页,leaving 为正在离场的页;
  // entered 标记是否经历过翻页(首次挂载不播入场动画)
  const [page, setPage] = useState(0);
  const [leaving, setLeaving] = useState(null);
  const [entered, setEntered] = useState(false);
  const pageRef = useRef(0);
  const leaveTimer = useRef(null);

  // 挂载时拉一次停靠快照(广播只在状态变化时推送),之后跟随变化
  useEffect(() => {
    let active = true;
    getEdgeDockState().then((s) => {
      if (active && s) setDock(s);
    }).catch(() => {});
    const off = on('edge-dock:state', (s) => setDock(s || null));
    return () => {
      active = false;
      if (typeof off === 'function') off();
    };
  }, []);

  // 只有一页时不启动播报;翻页用 ref 记当前页,避免闭包捕获旧值。
  // 进场与离场串行:离场动画播完(ANIM_MS)后下一页才挂载并播入场动画,两段不重合。
  useEffect(() => {
    if (PAGE_COUNT <= 1) return undefined;
    const timer = setInterval(() => {
      const current = pageRef.current;
      const next = (current + 1) % PAGE_COUNT;
      pageRef.current = next;
      setLeaving(current);
      leaveTimer.current = setTimeout(() => {
        setLeaving(null);
        setPage(next);
        setEntered(true);
      }, ANIM_MS);
    }, ROTATE_MS);
    return () => {
      clearInterval(timer);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
    };
  }, []);

  // 行顺序:启动读一次,之后跟随 settings:loaded 广播
  useEffect(() => {
    let active = true;
    getSettings().then((s) => {
      if (active) setRowOrder(parseRowOrder(s && s.window && s.window.miniRowOrder));
    }).catch(() => {});
    const off = on('settings:loaded', (s) => {
      setRowOrder(parseRowOrder(s && s.window && s.window.miniRowOrder));
    });
    return () => {
      active = false;
      if (typeof off === 'function') off();
    };
  }, []);

  // 收起竖条上的双击恢复(竖条无拖拽区,点击事件可达)
  const onClickRestore = () => {
    const now = Date.now();
    if (now - lastClickAt.current < 350) {
      lastClickAt.current = 0;
      toggleMini();
    } else {
      lastClickAt.current = now;
    }
  };

  const rawRates = {};
  (speed && Array.isArray(speed.providers) ? speed.providers : []).forEach((p) => {
    if (p && p.providerId) rawRates[p.providerId] = p.tokensPerMinute;
  });
  const rateOf = (pid) => {
    const raw = rawRates[pid];
    const value = Number(raw);
    return raw === null || raw === undefined || !Number.isFinite(value) ? '--' : formatTokenRate(value);
  };

  // 吸附收起:整窗只留竖条速度柱
  if (dock && dock.state === 'collapsed') {
    return <SpeedStrip edge={dock.edge} rates={rawRates} onRestore={onClickRestore} />;
  }

  const byId = {};
  (Array.isArray(providers) ? providers : []).forEach((p) => {
    if (p && p.id) byId[p.id] = p;
  });
  const balance = dashboard && dashboard.balance;
  const balanceTotal = balance && Number(balance.total);

  // 所有平台只负责准备数据；单环/两段/三段、中央读数和几何绘制统一由 QuotaRing 决定。
  const balanceSegments = [{ key: 'balance', label: '余额', frac: amountFrac(balanceTotal) }];
  const balanceVisual = (pid) => (
    <QuotaRing segments={balanceSegments} color={providerColor(pid)} label={amountLabel(balanceTotal)} />
  );
  const quotaVisual = (pid) => (
    <QuotaRing segments={quotaSegments(byId[pid])} color={providerColor(pid)} />
  );
  const visuals = {
    deepseek: balanceVisual('deepseek'),
    codex: quotaVisual('codex'),
    kimi: quotaVisual('kimi'),
    dsh: balanceVisual('dsh')
  };
  const rows = rowOrder.map((pid) => ({ key: pid, visual: visuals[pid] }));
  const pages = [];
  for (let i = 0; i < rows.length; i += PAGE_SIZE) pages.push(rows.slice(i, i + PAGE_SIZE));
  const renderRow = (row) => (
    <div className="mini-row" key={row.key}>
      {row.visual}
      <RowInfo pid={row.key} rate={rateOf(row.key)} />
    </div>
  );
  const currentPage = Math.min(page, pages.length - 1);

  return (
    <div className="mini-view">
      <img className="shen-deco mini-shen" src={SHEN.lying} alt="" aria-hidden="true" />
      <div className="mini-titlebar">
        <span className="mini-titlebar-text">Token Monitor</span>
        <div className="mini-titlebar-actions">
          <button className="mini-title-btn" title="放大至完整窗口" aria-label="放大至完整窗口" onClick={toggleMini}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
          </button>
          <button className="mini-title-btn" title="最小化" aria-label="最小化" onClick={() => send('window:minimize')}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3 8.5a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 8.5z" /></svg>
          </button>
          <button className="mini-title-btn" title="关闭(退至托盘)" aria-label="关闭" onClick={() => send('window:minimize')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      </div>
      <div className="mini-body">
        {leaving !== null && pages[leaving] ? (
          <div key={'leave-' + leaving} className="mini-page mini-page-leave">
            {pages[leaving].map(renderRow)}
          </div>
        ) : (
          <div
            key={'page-' + currentPage}
            className={'mini-page' + (entered ? ' mini-page-enter' : '')}
          >
            {(pages[currentPage] || []).map(renderRow)}
          </div>
        )}
      </div>
    </div>
  );
}
