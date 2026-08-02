// 单个额度窗口进度条:已用 used/limit(剩余 remaining),进度按 used/limit 着色
// (绿 <70% / 橙 <90% / 红 ≥90%);resetsAt 倒计时每分钟重渲染。
import React, { useEffect, useState } from 'react';
import { formatReset, formatTokenCount } from '../lib/format.js';

function percentClass(percent) {
  if (percent < 70) return 'low';
  if (percent < 90) return 'mid';
  return 'high';
}

export default function WindowBar({ kind, used, limit, remaining, resetsAt }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((k) => k + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  const limitNum = Number(limit) || 0;
  const percent = limitNum > 0 ? Math.min(100, Math.max(0, (Number(used) / limitNum) * 100)) : 0;

  return (
    <div className="quota-window">
      <div className="quota-window-head">
        <span className="quota-window-kind">{kind === '5h' ? '5 小时窗口' : '本周额度'}</span>
        <span className="quota-window-used">
          已用 {formatTokenCount(used)} / {formatTokenCount(limitNum)}
          {remaining !== undefined && remaining !== null ? `(剩余 ${formatTokenCount(remaining)})` : ''}
        </span>
      </div>
      <div className="quota-bar">
        <div className={'quota-bar-fill ' + percentClass(percent)} style={{ width: percent + '%' }} />
      </div>
      <div className="quota-window-reset">{formatReset(resetsAt, Date.now())}</div>
    </div>
  );
}
