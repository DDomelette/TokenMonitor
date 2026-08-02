import React from 'react';
import ResizeHandles from './components/ResizeHandles.jsx';
import TitleBar from './components/TitleBar.jsx';
import StatusBar from './components/StatusBar.jsx';
import { initProviders } from './store.js';

initProviders();

export default function App() {
  return (
    <>
      <ResizeHandles />
      <div id="app">
        <TitleBar />
        <div className="content">
          <div className="placeholder">渲染层迁移中…</div>
        </div>
        <StatusBar />
      </div>
    </>
  );
}
