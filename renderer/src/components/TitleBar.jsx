// 标题栏:刷新/设置/布局编辑/最小化/关闭按钮,图标沿用旧 SVG。
// 关闭按钮行为与旧版一致(隐藏到托盘 = window:minimize)。
// 刷新/设置点击有短暂图标动画;布局编辑按钮切换激活外观表示"编排中"。
import React, { useState } from 'react';
import { send } from '../api.js';

export default function TitleBar({ editing, onToggleLayoutEdit }) {
  const [spinning, setSpinning] = useState(false);
  const [gearTap, setGearTap] = useState(false);

  const onRefresh = () => {
    send('refresh:dashboard');
    setSpinning(true);
  };
  const onSettings = () => {
    send('open:settings');
    setGearTap(true);
  };

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <span className="titlebar-logo" aria-hidden="true">
          <svg viewBox="0 0 108 120" width="100%" height="100%">
            <rect x="0" y="0" width="32" height="32" rx="7" fill="#C3E2F9" />
            <rect x="38" y="0" width="32" height="32" rx="7" fill="#8FC6F3" />
            <rect x="76" y="0" width="32" height="32" rx="7" fill="#61ABEC" />
            <rect x="38" y="38" width="32" height="38" rx="7" fill="#79B9F0" />
            <rect x="38" y="82" width="32" height="38" rx="7" fill="#6DB3EE" />
          </svg>
        </span>
        <span className="titlebar-text">Token Monitor</span>
      </div>
      <div className="titlebar-actions">
        <button
          className={'titlebar-btn' + (spinning ? ' spin-refresh' : '')}
          title="立即刷新"
          onClick={onRefresh}
          onAnimationEnd={() => setSpinning(false)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
        </button>
        <button
          className={'titlebar-btn' + (gearTap ? ' spin-gear' : '')}
          title="设置"
          onClick={onSettings}
          onAnimationEnd={() => setGearTap(false)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
        </button>
        <button
          className={'titlebar-btn titlebar-btn-layout' + (editing ? ' active' : '')}
          title={editing ? '完成布局编排' : '编辑布局'}
          aria-label="编辑布局"
          aria-pressed={editing ? 'true' : 'false'}
          onClick={onToggleLayoutEdit}
        >
          <span className="layout-edit-icon" aria-hidden="true">▦</span>
        </button>
        <button className="titlebar-btn" title="最小化" onClick={() => send('window:minimize')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 8.5a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 8.5z" /></svg>
        </button>
        <button className="titlebar-btn" title="关闭" onClick={() => send('window:minimize')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
    </div>
  );
}
