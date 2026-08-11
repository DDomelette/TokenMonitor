// 主题化下拉:与设置页 custom-select 同款(圆角触发器 + 主题色菜单),
// 替代原生 <select>——原生展开列表由 OS 渲染,透明/暗色窗口里是直角白底。
// 菜单 portal 到 document.body:留在卡片内会被卡片的 overflow:hidden 裁剪,
// 且 backdrop-filter 会使 fixed 以卡片为包含块(同 heatmap tooltip 的坑)。
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export default function CustomSelect({ value, options, onChange, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const rootRef = useRef(null);
  const menuRef = useRef(null);

  // 打开时监听外部点击/Escape/滚动/窗口变化收起
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onDocMouseDown = (e) => {
      const inTrigger = rootRef.current && rootRef.current.contains(e.target);
      const inMenu = menuRef.current && menuRef.current.contains(e.target);
      if (!inTrigger && !inMenu) close();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    // 菜单是 fixed 定位,触发器随滚动/缩放移动后菜单会脱节,直接收起
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  function toggle() {
    if (!open && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      const menuHeight = options.length * 26 + 10;
      // 窗口内下方空间不足且上方更宽敞时向上展开
      const below = window.innerHeight - rect.bottom >= menuHeight || rect.top < menuHeight;
      setMenuPos({
        left: rect.left,
        width: Math.max(rect.width, 88),
        top: below ? rect.bottom + 4 : null,
        bottom: below ? null : window.innerHeight - rect.top + 4,
        below: below
      });
    }
    setOpen(!open);
  }

  function pick(v) {
    setOpen(false);
    onChange(v);
  }

  const current = options.find(([v]) => String(v) === String(value));
  return (
    <div ref={rootRef} className={'themed-select' + (open ? ' open' : '')}>
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
      {open && menuPos
        ? createPortal(
            <div
              ref={menuRef}
              className={'themed-select-menu' + (menuPos.below ? '' : ' drop-up')}
              role="listbox"
              style={{
                left: menuPos.left,
                width: menuPos.width,
                top: menuPos.top === null ? 'auto' : menuPos.top,
                bottom: menuPos.bottom === null ? 'auto' : menuPos.bottom
              }}
            >
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
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
