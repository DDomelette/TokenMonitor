import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './theme.css';
import './layout-lock.css';
import './provider-health.css';

createRoot(document.getElementById('root')).render(<App />);

// 贴边自动隐藏(issue #170):指针进入/离开窗口时通知主进程驱动展开/收起状态机。
// mouseenter/mouseleave 挂在 body 上,覆盖整个窗口区域(含收起时露出的触发条)。
if (window.api && window.api.send) {
  document.body.addEventListener('mouseenter', () => window.api.send('edge-dock:pointer-enter'));
  document.body.addEventListener('mouseleave', () => window.api.send('edge-dock:pointer-leave'));
}
