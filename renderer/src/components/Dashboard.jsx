// 仪表盘容器:gridstack 布局 + 组件渲染 + 编辑模式 + 布局持久化。
// 数据流:组件内部 useDashboard(store) 订阅,grid 结构由 useMemo 冻结,避免与 gridstack DOM 冲突。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GridStack } from 'gridstack';
import 'gridstack/dist/gridstack.min.css';
import { getSettings, send } from '../api.js';
import { useDashboard, useProviders } from '../store.js';
import {
  validateState,
  breakpointForWidth,
  nearestPreset
} from '../grid/policy.js';
import FeeCard from './FeeCard.jsx';
import ChartWidget from './ChartWidget.jsx';
import QuotaCard from './QuotaCard.jsx';

const LABELS = {
  'balance-card': '余额',
  'today-cost-card': '今日消耗',
  'cache-rate-card': '缓存命中率',
  'model-bar': '每日 Token 消耗',
  'token-line': 'Token 消耗',
  'cost-line': '费用增长趋势'
};

const FEE_IDS = ['balance-card', 'today-cost-card', 'cache-rate-card'];

function WidgetBody({ id }) {
  const dashboard = useDashboard('deepseek');
  if (FEE_IDS.includes(id)) {
    return <FeeCard id={id} balance={dashboard ? dashboard.balance : null} stats={dashboard ? dashboard.stats : null} />;
  }
  return <ChartWidget id={id} dashboard={dashboard} />;
}

export default function Dashboard({ editing }) {
  const hostRef = useRef(null);
  const gridRef = useRef(null);
  const layoutRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [rebuildKey, setRebuildKey] = useState(0);
  const bpRef = useRef(breakpointForWidth(window.innerWidth));
  const providers = useProviders();
  const quotaProviders = providers.filter((p) => p.capabilities && p.capabilities.quota);

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

    const grid = GridStack.makeGrid(host, {
      column: layout.columns,
      cellHeight: 24,
      margin: 8,
      float: false,
      animate: true,
      staticGrid: !editing,
      resizable: { handles: 'e, se, s, sw, w, nw, n, ne' }
    });
    gridRef.current = grid;

    const onChange = () => {
      if (!grid) return;
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
      grid.destroy(false);
      gridRef.current = null;
    };
  }, [ready, rebuildKey]);

  // 编辑模式:直接切换 staticGrid,不重建
  useEffect(() => {
    if (gridRef.current) gridRef.current.setStatic(!editing);
  }, [editing]);

  // 布局冻结:仅随 ready/rebuildKey 重建,避免 React 重渲染与 gridstack DOM 冲突
  const gridChildren = useMemo(() => {
    if (!ready) return null;
    const layout = layoutRef.current[bpRef.current];
    return layout.items.map((item) => (
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
        <div className={'grid-stack-item-content component-surface' + (FEE_IDS.includes(item.id) ? ' fee-card-surface' : '')}>
          <div className="component-title">{LABELS[item.id] || item.id}</div>
          <WidgetBody id={item.id} />
        </div>
      </section>
    ));
  }, [ready, rebuildKey]);

  if (!ready) {
    return <div className="content"><div className="placeholder">加载中…</div></div>;
  }

  return (
    <div className="content">
      {quotaProviders.length > 0 ? (
        <div className="quota-strip">
          {quotaProviders.map((p) => (
            <QuotaCard
              key={p.id}
              provider={p}
              quotaState={p.quota}
              authStatus={p.authStatus}
              onReauthorize={() => send('refresh:dashboard')}
            />
          ))}
        </div>
      ) : null}
      <div className="grid-stack" ref={hostRef}>
        {gridChildren}
      </div>
    </div>
  );
}
