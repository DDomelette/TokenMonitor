// 状态栏:展示 provider 快照中的成功时间、当前错误和陈旧状态。
import React, { useEffect, useMemo, useState } from 'react';
import { useProviders } from '../hooks/useProviders.js';
import { summarizeProviderHealth } from '../provider-health.mjs';

function formatRefresh(lastFetchedAt, now) {
  if (!Number.isFinite(lastFetchedAt)) return '--';
  const elapsed = Math.max(0, Math.floor((now - lastFetchedAt) / 60000));
  return elapsed === 0 ? '刚刚刷新' : elapsed + ' 分钟前';
}

export default function StatusBar() {
  const providers = useProviders();
  const health = useMemo(() => summarizeProviderHealth(providers), [providers]);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const refreshText = formatRefresh(health.lastFetchedAt, clock);

  return (
    <div className="statusbar">
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        <span className={`status-dot ${health.mode}`} />
        <span className="provider-health-text" title={health.text}>{health.text}</span>
      </div>
      <span>平台用量</span>
      <span>{refreshText}</span>
    </div>
  );
}
