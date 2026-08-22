import React, { useEffect, useState } from 'react';
import TitleBar from './components/TitleBar.jsx';
import StatusBar from './components/StatusBar.jsx';
import Dashboard from './components/Dashboard.jsx';
import MiniView from './components/MiniView.jsx';
import { initProviders } from './store.js';
import { getSettings, on, send } from './api.js';
import { installSettingsOpenBridge } from './settings-bridge.js';
import { installThemeSync } from './theme-sync.js';
import { installLayoutLockSync } from './layout-lock.js';
import { installLayoutResetSync } from './layout-reset-sync.js';

initProviders();

function readMiniMode(settings) {
  return !!(settings && settings.window && settings.window.miniMode === true);
}

export default function App() {
  const [editing, setEditing] = useState(false);
  const [layoutLocked, setLayoutLocked] = useState(true);
  const [dashboardGeneration, setDashboardGeneration] = useState(0);
  const [miniMode, setMiniMode] = useState(false);

  // 迷你模式状态:启动读一次,之后跟随设置广播(主进程切换后推送 settings:loaded)
  useEffect(() => {
    let active = true;
    getSettings().then((s) => {
      if (active) setMiniMode(readMiniMode(s));
    }).catch(() => {});
    const off = on('settings:loaded', (s) => setMiniMode(readMiniMode(s)));
    return () => {
      active = false;
      if (typeof off === 'function') off();
    };
  }, []);

  useEffect(() => installSettingsOpenBridge(on, send), []);

  useEffect(() => installThemeSync({
    getSettings,
    on,
    mediaQuery: window.matchMedia('(prefers-color-scheme: dark)'),
    root: document.documentElement,
    body: document.body,
    onWindowFocusState: (cb) => on('window:focus-state', cb),
    dispatchThemeApplied: (theme) => window.dispatchEvent(
      new CustomEvent('tokenmonitor:theme-applied', { detail: { theme } })
    )
  }), []);

  useEffect(() => installLayoutLockSync({
    getSettings,
    on,
    onChange: setLayoutLocked
  }), []);

  useEffect(() => installLayoutResetSync({
    getSettings,
    on,
    onReset: () => setDashboardGeneration((generation) => generation + 1)
  }), []);

  useEffect(() => {
    if (layoutLocked) setEditing(false);
  }, [layoutLocked]);

  // ctrl + 滚轮缩放(与旧版 app.js 行为一致):走主进程 zoom factor
  // 迷你模式禁用(主进程侧同样有守卫)
  useEffect(() => {
    const onWheel = (e) => {
      if (e.ctrlKey && !miniMode) {
        e.preventDefault();
        send('zoom:change', { delta: e.deltaY < 0 ? 0.1 : -0.1 });
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [miniMode]);

  const effectiveEditing = editing && !layoutLocked;
  const onToggleLayoutEdit = () => {
    if (!layoutLocked) setEditing((current) => !current);
  };

  // 缩放已由系统原生处理(resizable: true),不再渲染应用层 ResizeHandles
  // 迷你模式无标题栏(双击微缩窗口或托盘菜单恢复);key 切换触发淡入过渡,
  // 遮住窗口缩放与内容重排之间的一帧闪烁
  return (
    <div id="app" className={miniMode ? 'app-mini' : ''}>
      {!miniMode ? (
        <TitleBar
          editing={effectiveEditing}
          layoutLocked={layoutLocked}
          onToggleLayoutEdit={onToggleLayoutEdit}
        />
      ) : null}
      <div className="app-content" key={miniMode ? 'mini' : 'full'}>
        {miniMode
          ? <MiniView />
          : (
            <>
              <Dashboard key={dashboardGeneration} editing={effectiveEditing} />
              <StatusBar />
            </>
          )}
      </div>
    </div>
  );
}
