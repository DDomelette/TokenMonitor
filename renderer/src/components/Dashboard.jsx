// 仪表盘容器:gridstack 布局 + 组件渲染 + 编辑模式 + 布局持久化。
// 数据流:组件内部 useDashboard(store) 订阅,grid 结构由 useMemo 冻结,避免与 gridstack DOM 冲突。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GridStack } from 'gridstack';
import 'gridstack/dist/gridstack.min.css';
import { getSettings, send } from '../api.js';
import { useDashboard, useProviders } from '../store.js';
import {
  validateState,
  validateLayout,
  breakpointForWidth,
  nearestPreset
} from '../grid/policy.js';
import FeeCard from './FeeCard.jsx';
import ChartWidget from './ChartWidget.jsx';
import QuotaCard from './QuotaCard.jsx';
import TokenHeatmap from './TokenHeatmap.jsx';

const LABELS = {
  'balance-card': '余额',
  'today-cost-card': '今日消耗',
  'cache-rate-card': '缓存命中率',
  'model-bar': '每日 Token 消耗',
  'token-line': 'Token 消耗',
  'cost-line': '费用增长趋势'
};

const FEE_IDS = ['balance-card', 'today-cost-card', 'cache-rate-card'];
// 嵌入式板块:quota 卡与热力图也作为 grid item(自带标题,不再渲染 component-title)
const QUOTA_IDS = ['quota-codex', 'quota-kimi'];
const EMBED_IDS = QUOTA_IDS.concat(['token-heatmap']);
// 图表(echarts flex 填满可用高度,永不溢出)不参与自动撑高
const CHART_IDS = ['model-bar', 'token-line', 'cost-line'];

function WidgetBody({ id, onContentChange }) {
  const dashboard = useDashboard('deepseek');
  const providers = useProviders();
  // 数据驱动的重渲染后通知 grid 重新检查内容是否溢出(无依赖 = 每次渲染后都跑)
  useEffect(() => { if (onContentChange) onContentChange(); });
  if (FEE_IDS.includes(id)) {
    return <FeeCard id={id} balance={dashboard ? dashboard.balance : null} stats={dashboard ? dashboard.stats : null} />;
  }
  if (QUOTA_IDS.includes(id)) {
    const pid = id.slice('quota-'.length);
    const provider = providers.find((p) => p.id === pid);
    if (!provider) return <div className="embed-empty">未检测到 {pid} 数据源</div>;
    return (
      <QuotaCard
        provider={provider}
        quotaState={provider.quota}
        authStatus={provider.authStatus}
        onReauthorize={() => send('refresh:dashboard')}
      />
    );
  }
  if (id === 'token-heatmap') {
    return <TokenHeatmap />;
  }
  return <ChartWidget id={id} dashboard={dashboard} />;
}

export default function Dashboard({ editing }) {
  const hostRef = useRef(null);
  const gridRef = useRef(null);
  const layoutRef = useRef(null);
  const fitRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [rebuildKey, setRebuildKey] = useState(0);
  const bpRef = useRef(breakpointForWidth(window.innerWidth));
  const providers = useProviders();
  const quotaSig = providers.map((p) => p.id).join(',');
  const quotaSigRef = useRef(quotaSig);

  // quota 数据源上线/下线时重建 grid,让对应板块出现/隐藏
  useEffect(() => {
    if (quotaSigRef.current !== quotaSig) {
      quotaSigRef.current = quotaSig;
      setRebuildKey((k) => k + 1);
    }
  }, [quotaSig]);

  useEffect(() => {
    getSettings().then((settings) => {
      layoutRef.current = validateState(settings.layout, settings);
      setReady(true);
    }).catch(() => {});
  }, []);

  // 窗口宽度跨过断点(640)时重建 grid
  useEffect(() => {
    const onResize = () => {
      const bp = breakpointForWidth(window.innerWidth);
      if (bp !== bpRef.current) {
        bpRef.current = bp;
        setRebuildKey((k) => k + 1);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // grid 初始化/重建;change 时持久化布局
  useEffect(() => {
    if (!ready || !hostRef.current) return;
    const host = hostRef.current;
    const bp = bpRef.current;
    const layout = layoutRef.current[bp];

    const grid = GridStack.init({
      column: layout.columns,
      cellHeight: 24,
      margin: 8,
      float: false,
      animate: true,
      staticGrid: !editing,
      resizable: { handles: 'e, se, s, sw, w, nw, n, ne' }
    }, host);
    gridRef.current = grid;

    /* ---- 内容溢出时自动撑高模块(只增不减),替代内部滚动条 ----
       测量 .grid-stack-item-content 的 scrollHeight,超出即按格高增加 h。
       增长不写入预设布局(validateLayout 会按预设吸附,属预期),每次运行期重新撑高。 */
    let fitRaf = 0;
    const fitItems = () => {
      fitRaf = 0;
      const cell = grid.getCellHeight(true);
      if (!cell) return;
      host.querySelectorAll('.grid-stack-item').forEach((itemEl) => {
        const id = itemEl.getAttribute('gs-id');
        if (CHART_IDS.includes(id)) return;
        const content = itemEl.querySelector('.grid-stack-item-content');
        if (!content) return;
        if (content.scrollHeight - content.clientHeight <= 1) return;
        const node = itemEl.gridstackNode;
        const cur = node && node.h ? node.h : parseInt(itemEl.getAttribute('gs-h'), 10);
        const pad = itemEl.clientHeight - content.clientHeight;
        const need = Math.ceil((content.scrollHeight + pad) / cell);
        if (Number.isFinite(need) && need > cur) grid.update(itemEl, { h: need });
      });
    };
    const scheduleFit = () => {
      if (!fitRaf) fitRaf = requestAnimationFrame(fitItems);
    };
    fitRef.current = scheduleFit;
    // 窗口变窄文本换行、编辑模式手动缩放、异步数据到达都会改变所需高度
    const fitObserver = new ResizeObserver(scheduleFit);
    fitObserver.observe(host);
    const fitRetry1 = setTimeout(scheduleFit, 600);
    const fitRetry2 = setTimeout(scheduleFit, 1800);
    scheduleFit();

    const onChange = () => {
      if (!grid) return;
      scheduleFit();
      const saved = grid.save(false);
      const items = (saved || []).map((item) => {
        const preset = item.preset
          ? { w: item.w, h: item.h, name: item.preset }
          : nearestPreset(item.id, bp, item.w, item.h);
        return {
          id: item.id,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          preset: preset && preset.name
        };
      });
      const next = Object.assign({}, layoutRef.current, {
        [bp]: validateLayout(bp, { columns: layout.columns, items: items })
      });
      layoutRef.current = next;
      send('settings:update', { key: 'layout', value: next });
    };
    grid.on('change', onChange);

    return () => {
      grid.off('change');
      fitObserver.disconnect();
      if (fitRaf) cancelAnimationFrame(fitRaf);
      clearTimeout(fitRetry1);
      clearTimeout(fitRetry2);
      fitRef.current = null;
      grid.destroy(false);
      gridRef.current = null;
    };
  }, [ready, rebuildKey]);

  // 编辑模式:直接切换 staticGrid,不重建
  useEffect(() => {
    if (gridRef.current) gridRef.current.setStatic(!editing);
  }, [editing]);

  // 布局冻结:仅随 ready/rebuildKey 重建,避免 React 重渲染与 gridstack DOM 冲突
  // quota 板块只在其数据源存在时渲染 DOM(布局记录仍保留,数据源上线后重建恢复)
  const gridChildren = useMemo(() => {
    if (!ready) return null;
    const layout = layoutRef.current[bpRef.current];
    return layout.items
      .filter((item) => !QUOTA_IDS.includes(item.id) || providers.some((p) => 'quota-' + p.id === item.id))
      .map((item) => (
        <section
          key={item.id}
          className={'component-wrapper grid-stack-item ' + (FEE_IDS.includes(item.id) ? 'fee-card-widget' : 'chart-widget')}
          data-component-id={item.id}
          data-layout-preset={item.preset}
          gs-id={item.id}
          gs-x={item.x}
          gs-y={item.y}
          gs-w={item.w}
          gs-h={item.h}
        >
          <div className={'grid-stack-item-content component-surface' + (FEE_IDS.includes(item.id) ? ' fee-card-surface' : '') + (EMBED_IDS.includes(item.id) ? ' embed-surface' : '')}>
            {EMBED_IDS.includes(item.id) ? null : <div className="component-title">{LABELS[item.id] || item.id}</div>}
            <WidgetBody id={item.id} onContentChange={() => { if (fitRef.current) fitRef.current(); }} />
          </div>
        </section>
      ));
  }, [ready, rebuildKey]);

  if (!ready) {
    return <div className="content"><div className="placeholder">加载中…</div></div>;
  }

  return (
    <div className="content">
      <div className="grid-stack" ref={hostRef}>
        {gridChildren}
      </div>
    </div>
  );
}
