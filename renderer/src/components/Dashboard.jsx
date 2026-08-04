// 仪表盘容器:gridstack 布局 + 组件渲染 + 编辑模式 + 布局持久化。
// 数据流:组件内部 useDashboard(store) 订阅,grid 结构由 useMemo 冻结,避免与 gridstack DOM 冲突。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GridStack } from 'gridstack';
import 'gridstack/dist/gridstack.min.css';
import { getSettings, on, send } from '../api.js';
import { useDashboard, useProviders } from '../store.js';
import {
  validateState,
  validateLayout,
  breakpointForWidth,
  nearestPreset,
  presetAfterResize,
  nearestFreePosition
} from '../grid/policy.js';
import { mergeLayoutItems, visibleComponentIds } from '../grid/visibility.js';
import FeeCard from './FeeCard.jsx';
import ChartWidget from './ChartWidget.jsx';
import QuotaCard from './QuotaCard.jsx';
import TokenHeatmap from './TokenHeatmap.jsx';
import ProviderBar from './ProviderBar.jsx';

const LABELS = {
  'balance-card': '余额',
  'today-cost-card': '今日消耗',
  'cache-rate-card': '缓存命中率',
  'model-bar': 'DeepSeek 每日 Token 消耗',
  'provider-bar': '每日 Token 消耗',
  'token-line': 'Token 消耗',
  'cost-line': '费用增长趋势'
};

const FEE_IDS = ['balance-card', 'today-cost-card', 'cache-rate-card'];
// 嵌入式板块:quota 卡与热力图也作为 grid item(自带标题,不再渲染 component-title)
const QUOTA_IDS = ['quota-codex', 'quota-kimi'];
const EMBED_IDS = QUOTA_IDS.concat(['token-heatmap']);
// 图表(echarts flex 填满可用高度,永不溢出)不参与自动撑高
const CHART_IDS = ['model-bar', 'provider-bar', 'token-line', 'cost-line'];
// 各模块最小尺寸(grid 单位),防止编辑模式下压到不可用时手柄再也抓不到
const MIN_SIZES = {
  'quota-codex': { w: 6, h: 5 },
  'quota-kimi': { w: 6, h: 5 },
  'balance-card': { w: 4, h: 3 },
  'today-cost-card': { w: 4, h: 3 },
  'cache-rate-card': { w: 4, h: 3 },
  'model-bar': { w: 4, h: 4 },
  'provider-bar': { w: 4, h: 4 },
  'token-line': { w: 4, h: 4 },
  'cost-line': { w: 4, h: 4 },
  'token-heatmap': { w: 6, h: 10 }
};

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
  if (id === 'provider-bar') {
    return <ProviderBar />;
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
  const [settings, setSettings] = useState(null);
  const bpRef = useRef(breakpointForWidth(window.innerWidth));
  const providers = useProviders();
  const quotaSig = providers.map((p) => p.id).join(',');
  const quotaSigRef = useRef(quotaSig);
  const visibleIds = useMemo(
    () => new Set(visibleComponentIds(settings || {})),
    [settings]
  );
  const visibilitySignature = Array.from(visibleIds).sort().join(',');
  const visibilitySignatureRef = useRef(visibilitySignature);
  // 编辑模式镜像:自动撑高在编辑模式下必须停摆,否则 grid.update 会在
  // gridstack 拖拽缩放手势进行中改尺寸,破坏其内部拖拽状态导致"黏住鼠标"
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // quota 数据源上线/下线时重建 grid,让对应板块出现/隐藏
  useEffect(() => {
    if (quotaSigRef.current !== quotaSig) {
      quotaSigRef.current = quotaSig;
      setRebuildKey((k) => k + 1);
    }
  }, [quotaSig]);

  useEffect(() => {
    getSettings().then((nextSettings) => {
      const normalizedSettings = nextSettings || {};
      layoutRef.current = validateState(normalizedSettings.layout, normalizedSettings);
      visibilitySignatureRef.current = visibleComponentIds(normalizedSettings).sort().join(',');
      setSettings(normalizedSettings);
      setReady(true);
    }).catch(() => {});
  }, []);

  // 主进程在任意设置写入后广播 settings:loaded。只有可见 ID 集合变化时才重建 grid。
  useEffect(() => on('settings:loaded', (nextSettings) => {
    setSettings(nextSettings || {});
  }), []);

  useEffect(() => {
    if (!ready || visibilitySignatureRef.current === visibilitySignature) return;
    visibilitySignatureRef.current = visibilitySignature;
    setRebuildKey((k) => k + 1);
  }, [ready, visibilitySignature]);

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
      // 移动只认顶部拖拽柄:整个模块不再都是拖动区,抓边框缩放不会误触发移动
      draggable: { handle: '.module-drag-handle' },
      resizable: { handles: 'e, se, s, sw, w, nw, n, ne' }
    }, host);
    gridRef.current = grid;

    /* ---- 内容溢出时自动撑高模块(只增不减),替代内部滚动条 ----
       测量 .grid-stack-item-content 的 scrollHeight,超出即按格高增加 h。
       增长不写入预设布局(validateLayout 会按预设吸附,属预期),每次运行期重新撑高。 */
    let fitRaf = 0;
    const fitItems = () => {
      fitRaf = 0;
      if (editingRef.current) return; // 编辑模式下由用户手动定尺寸,绝不介入
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
      const mergedItems = mergeLayoutItems(layout.items, items);
      const next = Object.assign({}, layoutRef.current, {
        [bp]: validateLayout(bp, { columns: layout.columns, items: mergedItems })
      });
      layoutRef.current = next;
      send('settings:update', { key: 'layout', value: next });
    };
    grid.on('change', onChange);

    /* ---- 缩放手势:合法尺寸吸附 + 其他模块位置锁定 ----
       缩小时 gridstack 重力会让下方模块上浮换位,且自由尺寸会落在坐标轴被压扁的
       "bug 尺寸"。这里在手势期间切 float 禁止连带推动,松手时把被缩放模块吸附到
       最近的合法预设(presetAfterResize 按拖动方向进一档,避免小幅拖动弹回),
       其余模块一律还原到手势前的最近空位——相对位置永不因缩放而改变。 */
    let resizeSnapshot = null;
    grid.on('resizestart', () => {
      resizeSnapshot = {};
      host.querySelectorAll('.grid-stack-item').forEach((it) => {
        const n = it.gridstackNode;
        if (n) resizeSnapshot[n.id] = { x: n.x, y: n.y, w: n.w, h: n.h };
      });
      grid.float(true);
    });
    grid.on('resizestop', (event, el) => {
      const snapshot = resizeSnapshot;
      resizeSnapshot = null;
      const node = el.gridstackNode;
      if (!node) { grid.float(false); return; }
      const start = snapshot && snapshot[node.id];
      const snap = presetAfterResize(node.id, bp, start, { w: node.w, h: node.h })
        || nearestPreset(node.id, bp, node.w, node.h);
      const box = snap
        ? { x: Math.min(node.x, layout.columns - snap.w), y: node.y, w: snap.w, h: snap.h }
        : { x: node.x, y: node.y, w: node.w, h: node.h };
      grid.batchUpdate();
      grid.update(el, box);
      const placed = [Object.assign({ id: node.id }, box)];
      const others = [];
      host.querySelectorAll('.grid-stack-item').forEach((it) => {
        if (it === el) return;
        const n = it.gridstackNode;
        const orig = snapshot && n && snapshot[n.id];
        if (n && orig) others.push({ el: it, node: n, orig: orig });
      });
      others.sort((a, b) => (a.orig.y - b.orig.y) || (a.orig.x - b.orig.x));
      others.forEach((entry) => {
        const candidate = {
          id: entry.node.id,
          x: entry.orig.x,
          y: entry.orig.y,
          w: entry.node.w,
          h: entry.node.h
        };
        const pos = nearestFreePosition(candidate, placed, layout.columns);
        if (pos.x !== entry.node.x || pos.y !== entry.node.y) {
          grid.update(entry.el, { x: pos.x, y: pos.y });
        }
        placed.push(pos);
      });
      grid.batchUpdate(false);
      grid.float(false);
    });

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

  // 编辑模式:直接切换 staticGrid,不重建;编辑模式下关掉位移动画,
  // 否则缩放时下方模块的跟随动画持续改变容器高度,页面滚动条会乱跳
  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.setStatic(!editing);
      gridRef.current.setAnimation(!editing);
    }
    // 退出编辑模式时补一次撑高:编辑中被手动压小的模块在此恢复合身尺寸
    if (!editing && fitRef.current) fitRef.current();
  }, [editing]);

  // 布局冻结:仅随 ready/rebuildKey 重建,避免 React 重渲染与 gridstack DOM 冲突
  // 设置关闭或 quota 数据源缺失的板块不渲染 DOM,但完整布局记录始终保留。
  const gridChildren = useMemo(() => {
    if (!ready) return null;
    const layout = layoutRef.current[bpRef.current];
    return layout.items
      .filter((item) => visibleIds.has(item.id))
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
          gs-min-w={MIN_SIZES[item.id] ? MIN_SIZES[item.id].w : undefined}
          gs-min-h={MIN_SIZES[item.id] ? MIN_SIZES[item.id].h : undefined}
        >
          <div className="module-drag-handle" aria-hidden="true" />
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
      <div key={rebuildKey} className={'grid-stack' + (editing ? ' editing' : '')} ref={hostRef}>
        {gridChildren}
      </div>
    </div>
  );
}
