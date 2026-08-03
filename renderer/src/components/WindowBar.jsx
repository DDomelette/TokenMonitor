// 单个额度窗口进度条:条长=剩余额度占比(剩余越少条越短),按剩余百分比着色
// (>40% 绿 / 20~40% 黄 / ≤20% 红);剩余为 0 时整条斜纹填满。resetsAt 倒计时每分钟重渲染。
import React, { useEffect, useState } from 'react';
import { formatReset, formatTokenCount } from '../lib/format.js';

function remainingClass(percent) {
  if (percent > 40) return 'low';
  if (percent > 20) return 'mid';
  return 'high';
}

export default function WindowBar({ kind, name, used, limit, remaining, resetsAt }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((k) => k + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const limitNum = Number(limit) || 0;
  const remainingNum = remaining !== undefined && remaining !== null
    ? Number(remaining) || 0
    : Math.max(0, limitNum - (Number(used) || 0));
  const percent = limitNum > 0 ? Math.min(100, Math.max(0, (remainingNum / limitNum) * 100)) : 0;
  const empty = limitNum > 0 && remainingNum <= 0;

  return (
    <div className="quota-window">
      <div className="quota-window-head">
        <span className="quota-window-kind">{name || (kind === '5h' ? '5 小时窗口' : '本周额度')}</span>
        <span className="quota-window-used">
          已用 {formatTokenCount(used)} / {formatTokenCount(limitNum)}
          {remaining !== undefined && remaining !== null ? `(剩余 ${formatTokenCount(remaining)})` : ''}
        </span>
      </div>
      <div className="quota-bar">
        <div
          className={'quota-bar-fill ' + (empty ? 'empty' : remainingClass(percent))}
          style={{ width: (empty ? 100 : percent) + '%' }}
        />
      </div>
      <div className="quota-window-reset">{formatReset(resetsAt, Date.now())}</div>
    </div>
  );
}
