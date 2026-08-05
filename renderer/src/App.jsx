import React, { useEffect, useState } from 'react';
import TitleBar from './components/TitleBar.jsx';
import StatusBar from './components/StatusBar.jsx';
import Dashboard from './components/Dashboard.jsx';
import { initProviders } from './store.js';
import { getSettings, on, send } from './api.js';
import { installSettingsOpenBridge } from './settings-bridge.js';
import { installThemeSync } from './theme-sync.js';

initProviders();

export default function App() {
  const [editing, setEditing] = useState(false);

  useEffect(() => installSettingsOpenBridge(on, send), []);

  useEffect(() => installThemeSync({
    getSettings,
    on,
    mediaQuery: window.matchMedia('(prefers-color-scheme: dark)'),
    root: document.documentElement,
    body: document.body,
    dispatchThemeApplied: (theme) => window.dispatchEvent(
      new CustomEvent('tokenmonitor:theme-applied', { detail: { theme } })
    )
  }), []);

  // ctrl + 滚轮缩放(与旧版 app.js 行为一致):走主进程 zoom factor
  useEffect(() => {
    const onWheel = (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        send('zoom:change', { delta: e.deltaY < 0 ? 0.1 : -0.1 });
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  // 缩放已由系统原生处理(resizable: true),不再渲染应用层 ResizeHandles
  return (
    <div id="app">
      <TitleBar editing={editing} onToggleLayoutEdit={() => setEditing((e) => !e)} />
      <Dashboard editing={editing} />
      <StatusBar />
    </div>
  );
}
