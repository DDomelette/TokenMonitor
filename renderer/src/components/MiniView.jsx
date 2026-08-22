// 迷你模式视图:Codex 周额度圆环、Kimi 双环(外 5 小时/内本周)、DeepSeek 余额,
// 右侧为各平台 Token 消耗速度(与速度卡片同源:tokensPerMinute + formatTokenRate)。
// 顶部栏含放大/最小化/关闭三钮;整窗为系统原生拖拽区(拖动顺滑不依赖 JS);
// 贴边吸附收起后切换为竖条速度柱(柱子越高速度越快),竖条上双击恢复完整模式。
import React, { useEffect, useRef, useState } from 'react';
import { useProviders, useDashboard } from '../store.js';
import useTokenSpeed from '../hooks/useTokenSpeed.js';
import { on, send, toggleMini, getEdgeDockState } from '../api.js';
import { PROVIDER_META, formatTokenRate } from '../lib/token-speed-chart.js';
import { formatCurrencyAmount } from '../fee-card-money.mjs';

const RING_R = 17;
const RING_C = 2 * Math.PI * RING_R;
// 内环与外环相贴:内环外缘(半径+半个线宽)= 外环内缘(17 - 4.5/2 = 14.75)
const INNER_R = 12.75;
const INNER_C = 2 * Math.PI * INNER_R;
// 内环用同色降透明度区分外环
const KIMI_INNER_COLOR = 'rgba(78, 203, 148, 0.55)';

// 取指定种类的额度窗口;附加限额(如 Codex 的 Spark)带 name,主额度 name 为 null,优先主额度
function windowByKind(provider, kind) {
  const quota = provider && provider.quota;
  const windows = quota && Array.isArray(quota.windows) ? quota.windows : [];
  const matches = windows.filter((w) => w && w.kind === kind);
  return matches.find((w) => !w.name) || matches[0] || null;
}

// 剩余比例(0–1);无数据/认证异常返回 null(只画灰轨道)
function fracOf(win) {
  if (!win) return null;
  const limit = Number(win.limit);
  const remaining = Number(win.remaining);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null;
  return Math.max(0, Math.min(1, remaining / limit));
}

function Arc({ radius, circumference, frac, color, width }) {
  if (frac === null) return null;
  return (
    <circle
      cx="22" cy="22" r={radius} fill="none"
      stroke={color} strokeWidth={width} strokeLinecap="round"
      strokeDasharray={circumference * frac + ' ' + circumference}
      transform="rotate(-90 22 22)"
    />
  );
}

function Ring({ outer, inner, color, innerColor }) {
  const label = outer === null ? '--' : Math.round(outer * 100) + '%';
  return (
    <div className="mini-ring-wrap">
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r={RING_R} fill="none" stroke="var(--border)" strokeWidth="4.5" />
        <Arc radius={RING_R} circumference={RING_C} frac={outer} color={color} width={4.5} />
        {inner !== undefined ? (
          <>
            <circle cx="22" cy="22" r={INNER_R} fill="none" stroke="var(--border)" strokeWidth="4" />
            <Arc radius={INNER_R} circumference={INNER_C} frac={inner} color={innerColor || color} width={4} />
          </>
        ) : null}
      </svg>
      <span className="mini-ring-label">{label}</span>
    </div>
  );
}

function RowInfo({ pid, rate }) {
  const meta = PROVIDER_META[pid];
  return (
    <div className="mini-row-info">
      <span className="mini-dot" style={{ background: meta.color }} />
      <span className="mini-name">{meta.label}</span>
      <span className="mini-speed">{rate}</span>
    </div>
  );
}

// 贴边收起后的竖条:每个平台一条全程轨道(灰白色,与背景区分),
// 底部彩色填充高度 ∝ 当前速度(三者相对最大值归一,1K/min 地板),速度为 0 时轨道全空。
// 顶边吸附时可见区是横条,速度映射为横向长度
function SpeedStrip({ edge, rates, onRestore }) {
  const values = ['deepseek', 'codex', 'kimi'].map((pid) => Number(rates[pid]) || 0);
  const max = Math.max(1000, ...values);
  const horizontal = edge === 'top';
  return (
    <div className={'mini-strip mini-strip-' + (edge === 'left' || edge === 'top' ? edge : 'right')} onClick={onRestore}>
      {['deepseek', 'codex', 'kimi'].map((pid, i) => {
        const pct = Math.round((values[i] / max) * 100) + '%';
        return (
          <div key={pid} className="mini-strip-bar">
            <div
              className="mini-strip-fill"
              style={horizontal
                ? { background: PROVIDER_META[pid].color, width: pct }
                : { background: PROVIDER_META[pid].color, height: pct }}
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

  return (
    <div className="mini-view">
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
        <div className="mini-row">
          <div className="mini-balance">
            {balance ? formatCurrencyAmount(balance.currency, balance.total) : '--'}
          </div>
          <RowInfo pid="deepseek" rate={rateOf('deepseek')} />
        </div>
        <div className="mini-row">
          <Ring outer={fracOf(windowByKind(byId.codex, 'weekly'))} color={PROVIDER_META.codex.color} />
          <RowInfo pid="codex" rate={rateOf('codex')} />
        </div>
        <div className="mini-row">
          <Ring
            outer={fracOf(windowByKind(byId.kimi, '5h'))}
            inner={fracOf(windowByKind(byId.kimi, 'weekly'))}
            color={PROVIDER_META.kimi.color}
            innerColor={KIMI_INNER_COLOR}
          />
          <RowInfo pid="kimi" rate={rateOf('kimi')} />
        </div>
      </div>
    </div>
  );
}
