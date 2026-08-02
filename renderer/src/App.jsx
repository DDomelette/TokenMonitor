import React from 'react';

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export default function App() {
  return (
    <>
      <div className="resize-layer">
        {EDGES.map((edge) => (
          <div key={edge} className={`resize-handle resize-${edge}`} />
        ))}
      </div>
      <div id="app">
        <div className="titlebar">
          <div className="titlebar-left">
            <span className="titlebar-logo"> </span>
            <span className="titlebar-text">DeepSeek Monitor v2</span>
          </div>
        </div>
        <div className="content">
          <div className="placeholder">渲染层迁移中…</div>
        </div>
      </div>
    </>
  );
}
