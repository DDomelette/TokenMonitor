// 每日 Token 消耗(全平台堆叠柱):数据与热力图同源(get:heatmap 的 details.byProvider),
// 最近 31 天零填充;堆叠自下而上 Codex → Kimi → DeepSeek;悬浮窗仿 model-bar(加粗日期 + 圆点行 + 缓存后缀 + 合计)。
import React, { useEffect, useRef, useState } from 'react';
import useECharts from '../hooks/useECharts.js';
import { getHeatmap, onProvidersChanged } from '../api.js';
import { getBarTheme } from '../lib/chartTheme.js';
import { formatToken as formatWan } from '../lib/heatmap.js';
import { barDensity, isCardMode, formatToken, windowClampedPosition } from './ChartWidget.jsx';

const DAYS = 31;
// 堆叠顺序即 series 顺序:第一个在底部;颜色在品牌色基础上降纯度,柔和但不发灰
const STACK = [
  { id: 'codex', label: 'Codex', color: '#F2A05C' },
  { id: 'kimi', label: 'Kimi', color: '#4ECB94' },
  { id: 'deepseek', label: 'DeepSeek', color: '#6E94F5' }
];

function lastDays(count) {
  const pad = (n) => String(n).padStart(2, '0');
  const days = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
  }
  return days;
}

function buildOption(dom, details, dates) {
  const isDark = document.body.classList.contains('dark');
  const t = getBarTheme(isDark);
  const byProvider = (details && details.byProvider) || {};
  const cachedByProvider = (details && details.cachedByProvider) || {};
  const density = barDensity(t, dom, isCardMode(dom));
  return {
    color: STACK.map((p) => p.color),
    backgroundColor: 'transparent',
    textStyle: { color: t.textColor, fontSize: 10 },
    grid: density.grid,
    tooltip: {
      trigger: 'axis',
      // 挂 body 避免被模块 overflow 裁切;位置钳制在窗口内,被遮挡时向中间靠拢
      appendToBody: true,
      position: windowClampedPosition(dom),
      axisPointer: { type: 'shadow' },
      textStyle: { fontSize: 11 },
      formatter: (params) => {
        const date = params && params[0] ? dates[params[0].dataIndex] : '';
        let total = 0;
        const lookup = {};
        (params || []).forEach((p) => { total += p.value || 0; lookup[p.seriesName] = p; });
        const cachedSuffix = (pid) => {
          const c = cachedByProvider[pid] && Number(cachedByProvider[pid][date]);
          return c > 0 ? '（缓存 ' + formatWan(c) + '）' : '';
        };
        // 显示顺序与堆叠视觉一致:自上而下 DeepSeek → Kimi → Codex
        const parts = STACK.slice().reverse().map((provider) => {
          const p = lookup[provider.label];
          if (!p) return '';
          return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + p.color + '"></span> ' + provider.label + ': ' + formatWan(p.value) + ' Token' + cachedSuffix(provider.id);
        });
        return '<b>' + (params[0] ? params[0].axisValue : '') + '</b><br/>' + parts.join('<br/>') + '<br/><b>合计: ' + formatWan(total) + ' Token</b>';
      }
    },
    xAxis: Object.assign({ type: 'category', data: dates.map((d) => d.slice(5)) }, density.xAxis),
    // density.yAxis.axisLabel 只含 show/fontSize,必须显式合并,否则 formatter 被整体覆盖丢千分位缩写
    yAxis: Object.assign({ type: 'value' }, density.yAxis, {
      axisLabel: Object.assign({ color: t.textColor, fontSize: 9, formatter: (v) => formatToken(v) }, density.yAxis.axisLabel)
    }),
    animation: true,
    series: STACK.map((provider, i) => Object.assign({
      name: provider.label,
      type: 'bar',
      stack: 'total',
      // 只有堆叠顶层(DeepSeek)带圆角
      itemStyle: { borderRadius: i === STACK.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0] },
      data: dates.map((date) => (byProvider[provider.id] && Number(byProvider[provider.id][date])) || 0)
    }, density.series && density.series[i]))
  };
}

export default function ProviderBar() {
  const domRef = useRef(null);
  const [details, setDetails] = useState(null);
  const year = new Date().getFullYear();
  const dates = lastDays(DAYS);

  useEffect(() => {
    getHeatmap({ provider: 'all', year: year })
      .then((data) => setDetails(data ? data.details : null))
      .catch(() => {});
  }, [year]);

  // 手动刷新/定时轮询成功后重取,与热力图保持同源同步
  useEffect(() => {
    return onProvidersChanged(() => {
      getHeatmap({ provider: 'all', year: year })
        .then((data) => setDetails(data ? data.details : null))
        .catch(() => {});
    });
  }, [year]);

  useECharts(domRef, () => buildOption(domRef.current, details, dates), [details]);

  return <div className="chart-container" ref={domRef} />;
}
