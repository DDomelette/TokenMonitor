// 标题栏:刷新/设置/布局编辑/最小化/关闭按钮,图标沿用旧 SVG。
// 关闭按钮行为与旧版一致(隐藏到托盘 = window:minimize)。
import React from 'react';
import { send } from '../api.js';

export default function TitleBar({ onToggleLayoutEdit }) {
  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <span className="titlebar-logo" />
        <span className="titlebar-text">DeepSeek Monitor</span>
      </div>
      <div className="titlebar-actions">
        <button className="titlebar-btn" title="立即刷新" onClick={() => send('refresh:dashboard')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5b6372" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
        </button>
        <button className="titlebar-btn" title="设置" onClick={() => send('open:settings')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="#5b6372"><path d="M7.5 1a6.5 6.5 0 0 1 5.91 9.08l2.25 2.25a.75.75 0 1 1-1.06 1.06l-2.25-2.25A6.5 6.5 0 1 1 7.5 1zm0 1.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10z" /><circle cx="7.5" cy="7.5" r="2.5" /></svg>
        </button>
        <button className="titlebar-btn" title="编辑布局" aria-label="编辑布局" aria-pressed="false" onClick={onToggleLayoutEdit}>
          <span className="layout-edit-icon" aria-hidden="true">▦</span>
        </button>
        <button className="titlebar-btn" title="最小化" onClick={() => send('window:minimize')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="#5b6372"><path d="M3 8.5a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 8.5z" /></svg>
        </button>
        <button className="titlebar-btn" title="关闭" onClick={() => send('window:minimize')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="#5b6372"><path d="M3.22 3.22a.75.75 0 0 1 1.06 0L8 6.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L9.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 0 1 0-1.06z" /></svg>
        </button>
      </div>
    </div>
  );
}
