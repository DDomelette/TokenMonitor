// 状态栏:连接状态点 + 刷新时间(与旧版 statusbar 行为一致)。
// providers:changed 快照里有任一 provider 拿到数据即视为"数据连接正常"。
import React, { useEffect, useState } from 'react';
import { onProvidersChanged } from '../api.js';

function hasData(snapshot) {
  return Array.isArray(snapshot) && snapshot.some((p) => p.quota || p.lastError === null);
}

export default function StatusBar() {
  const [status, setStatus] = useState({ running: false, error: null });
  const [refreshText, setRefreshText] = useState('--');
  const [lastRefresh] = useState(Date.now());

  useEffect(() => {
    onProvidersChanged((snapshot) => {
      setStatus({ running: hasData(snapshot), error: null });
    });
  }, []);

  useEffect(() => {
    const update = () => {
      const elapsed = Math.floor((Date.now() - lastRefresh) / 60000);
      setRefreshText(elapsed === 0 ? '刚刚刷新' : elapsed + ' 分钟前');
    };
    update();
    const timer = setInterval(update, 15000);
    return () => clearInterval(timer);
  }, [lastRefresh]);

  return (
    <div className="statusbar">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span className={`status-dot ${status.running ? 'online' : 'offline'}`} />
        <span>{status.running ? '数据连接正常' : (status.error || '未获取数据')}</span>
      </div>
      <span>平台用量</span>
      <span>{refreshText}</span>
    </div>
  );
}
