import React, { useEffect, useState } from 'react';
import ResizeHandles from './components/ResizeHandles.jsx';
import TitleBar from './components/TitleBar.jsx';
import StatusBar from './components/StatusBar.jsx';
import Dashboard from './components/Dashboard.jsx';
import { initProviders } from './store.js';
import { send } from './api.js';

initProviders();

export default function App() {
  const [editing, setEditing] = useState(false);

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

  return (
    <>
      <ResizeHandles />
      <div id="app">
        <TitleBar editing={editing} onToggleLayoutEdit={() => setEditing((e) => !e)} />
        <Dashboard editing={editing} />
        <StatusBar />
      </div>
    </>
  );
}
