// 主题化下拉:与设置页 custom-select 同款(圆角触发器 + 主题色菜单),
// 替代原生 <select>——原生展开列表由 OS 渲染,透明/暗色窗口里是直角白底。
import React, { useEffect, useRef, useState } from 'react';

export default function CustomSelect({ value, options, onChange, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef(null);

  // 打开时监听外部点击/Escape 收起
  useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function toggle() {
    if (!open && rootRef.current) {
      // 卡片内剩余空间不足时向上展开,避免菜单被卡片 overflow 裁切
      const card = rootRef.current.closest('.token-speed-card');
      const bounds = (card || document.body).getBoundingClientRect();
      const triggerBottom = rootRef.current.getBoundingClientRect().bottom;
      const menuHeight = options.length * 26 + 10;
      setDropUp(bounds.bottom - triggerBottom < menuHeight);
    }
    setOpen(!open);
  }

  function pick(v) {
    setOpen(false);
    onChange(v);
  }

  const current = options.find(([v]) => String(v) === String(value));
  return (
    <div ref={rootRef} className={'themed-select' + (open ? ' open' : '') + (dropUp ? ' drop-up' : '')}>
      <button
        type="button"
        className="themed-select-trigger"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="themed-select-label">{current ? current[1] : String(value)}</span>
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="themed-select-menu" role="listbox">
        {options.map(([v, label]) => (
          <div
            key={v}
            role="option"
            aria-selected={String(v) === String(value)}
            className={'themed-select-option' + (String(v) === String(value) ? ' selected' : '')}
            onClick={() => pick(v)}
          >
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}
