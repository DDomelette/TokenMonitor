import React, { useState } from 'react';
import ResizeHandles from './components/ResizeHandles.jsx';
import TitleBar from './components/TitleBar.jsx';
import StatusBar from './components/StatusBar.jsx';
import Dashboard from './components/Dashboard.jsx';
import { initProviders } from './store.js';

initProviders();

export default function App() {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <ResizeHandles />
      <div id="app">
        <TitleBar onToggleLayoutEdit={() => setEditing((e) => !e)} />
        <Dashboard editing={editing} />
        <StatusBar />
      </div>
    </>
  );
}
