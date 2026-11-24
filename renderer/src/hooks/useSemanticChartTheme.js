import { useEffect, useState } from 'react';
import { getSemanticChartTheme } from '../lib/chartTheme.js';

function readTheme() {
  return getSemanticChartTheme(document.body.classList.contains('dark'));
}

// ECharts 与 DOM 图例共用同一注册表；主题事件在 CSS 变量应用后由 theme-sync 发出。
export default function useSemanticChartTheme() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const update = () => setTheme(readTheme());
    update();
    window.addEventListener('tokenmonitor:theme-applied', update);
    return () => window.removeEventListener('tokenmonitor:theme-applied', update);
  }, []);
  return theme;
}
