// 仪表盘容器:gridstack 布局 + 注册组件渲染 + 编辑模式 + 布局持久化。
// grid 结构由 useMemo 冻结,避免与 gridstack DOM 冲突；组件差异由注册表声明。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GridStack } from 'gridstack';
import { applyGridItemHeights, fitGridItemHeight } from '../grid/fit-height.js';
import { createResizeIsolatedEngine, isResizeBeyondLimits } from '../grid/resize-engine.js';
import { list as listComponents, get as getComponent } from '../grid/components.js';
import RegisteredWidgetBody from '../grid/widget-runtime.jsx';
import 'gridstack/dist/gridstack.min.css';
import { getSettings, on, send } from '../api.js';
import { useProviders } from '../store.js';
import {
  validateState,
  validateLayout,
  breakpointForWidth,
  nearestPreset,
  presetAfterResize,
  nearestFreePosition
} from '../grid/policy.js';
import { mergeLayoutItems, visibleComponentIds } from '../grid/visibility.js';
import { ChartRangeToolbar } from './ChartRange.jsx';

const DashboardGridEngine = createResizeIsolatedEngine(GridStack);
const COMPONENTS = listComponents();
const USAGE_CHART_IDS = COMPONENTS.filter((component) => component.usesChartRange)
  .map((component) => component.id);

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
    // 设置服务暂时不可用时仍使用默认布局，避免窗口永久停留在加载态。
    getSettings().catch(() => ({})).then((nextSettings) => {
      const normalizedSettings = nextSettings || {};
      layoutRef.current = validateState(normalizedSettings.layout, normalizedSettings);
      visibilitySignatureRef.current = visibleComponentIds(normalizedSettings).sort().join(',');
      setSettings(normalizedSettings);
      setReady(true);
    });
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
      engineClass: DashboardGridEngine,
      // 移动只认顶部拖拽柄:整个模块不再都是拖动区,抓边框缩放不会误触发移动
      draggable: { handle: '.module-drag-handle' },
      resizable: { handles: 'e, se, s, sw, w, nw, n, ne' }
    }, host);
    gridRef.current = grid;
    // GridStack 不读取自定义 preset 属性；显式挂到节点上，避免拖动中的临时尺寸
    // 被当成新预设，也让自动撑高后的下一次手势仍能认出原预设。
    host.querySelectorAll('.grid-stack-item').forEach((itemEl) => {
      const node = itemEl.gridstackNode;
      if (node) node.preset = itemEl.dataset.layoutPreset;
    });

    /* ---- 内容溢出时自动撑高模块,替代内部滚动条 ----
       测量 .grid-stack-item-content 的 scrollHeight,按格高调整到合身。
       记住本轮已测得的所需高度,避免基准高度本身不足时反复伸缩;
       内容、主题或宽度变化时清除记忆,重新探测是否可以缩回布局基准。 */
    let fitRaf = 0;
    const fittedHeights = new Map();
    const fitItems = () => {
      fitRaf = 0;
      if (editingRef.current) return; // 编辑模式下由用户手动定尺寸,绝不介入
      const cell = grid.getCellHeight(true);
      if (!cell) return;
      const baseItems = (layoutRef.current[bp] && layoutRef.current[bp].items) || [];
      const updates = [];
      host.querySelectorAll('.grid-stack-item').forEach((itemEl) => {
        const id = itemEl.getAttribute('gs-id');
        const component = getComponent(id);
        if (!component || !component.autoFit) return;
        const content = itemEl.querySelector('.grid-stack-item-content');
        if (!content) return;
        const node = itemEl.gridstackNode;
        const cur = node && node.h ? node.h : parseInt(itemEl.getAttribute('gs-h'), 10);
        const pad = itemEl.clientHeight - content.clientHeight;
        const baseItem = baseItems.find((it) => it.id === id);
        const base = Math.max(
          baseItem && baseItem.h ? baseItem.h : 1,
          component.minSize.h
        );
        const target = fitGridItemHeight({
          base,
          cell,
          padding: pad,
          scrollHeight: content.scrollHeight,
          clientHeight: content.clientHeight,
          retainedHeight: fittedHeights.get(id)
        });
        if (content.scrollHeight > content.clientHeight + 1) fittedHeights.set(id, target);
        else if (target === base) fittedHeights.delete(id);
        if (target !== cur) updates.push({ itemEl, h: target });
      });
      applyGridItemHeights(grid, host, updates);
    };
    const scheduleFit = () => {
      if (!fitRaf) fitRaf = requestAnimationFrame(fitItems);
    };
    const refitContent = () => {
      fittedHeights.clear();
      scheduleFit();
    };
    fitRef.current = refitContent;
    // 只有宽度变化会使文本重新换行;自动撑高引起的 host 高度变化不能清除测高记忆。
    let lastFitWidth = host.clientWidth;
    const fitObserver = new ResizeObserver(() => {
      const width = host.clientWidth;
      if (width !== lastFitWidth) {
        lastFitWidth = width;
        fittedHeights.clear();
      }
      scheduleFit();
    });
    fitObserver.observe(host);
    window.addEventListener('tokenmonitor:theme-applied', refitContent);
    const fitRetry1 = setTimeout(scheduleFit, 600);
    const fitRetry2 = setTimeout(scheduleFit, 1800);
    scheduleFit();

    const onChange = () => {
      if (!grid) return;
      scheduleFit();
      // 非编辑模式 staticGrid 下用户无法拖动/缩放,change 只可能来自自动撑高;
      // 运行期撑高不落盘(原设计意图),否则瞬时溢出会被 nearestPreset 吸附进
      // 持久布局,跨会话永久累积抬高模块高度。
      if (!editingRef.current) return;
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
       ResizeIsolatedEngine 在手势期间只更新当前节点,不把碰撞组件临时推开。
       松手时把被缩放模块吸附到最近合法预设(presetAfterResize 按拖动方向进一档),
       其余模块回到手势前的最近空位,统一结算重叠后再持久化。 */
    let resizeSnapshot = null;
    const setResizeLimitFeedback = (el, exceeded) => {
      if (!el) return;
      el.classList.toggle('is-resize-invalid', exceeded);
      let feedback = el.querySelector(':scope > .resize-limit-feedback');
      if (exceeded && !feedback) {
        feedback = document.createElement('div');
        feedback.className = 'resize-limit-feedback';
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('aria-label', '已超过最大尺寸，松手后将自动调整为可用尺寸');
        feedback.title = '松手后将自动调整为最接近的可用尺寸';
        feedback.textContent = '超过最大尺寸';
        el.appendChild(feedback);
      } else if (!exceeded && feedback) {
        feedback.remove();
      }
    };
    grid.on('resizestart', (event, el) => {
      setResizeLimitFeedback(el, false);
      resizeSnapshot = {};
      host.querySelectorAll('.grid-stack-item').forEach((it) => {
        const n = it.gridstackNode;
        if (n) resizeSnapshot[n.id] = { x: n.x, y: n.y, w: n.w, h: n.h, preset: n.preset };
      });
    });
    grid.on('resize', (event, el) => {
      const node = el.gridstackNode;
      const component = node && getComponent(node.id);
      const start = node && resizeSnapshot && resizeSnapshot[node.id];
      const exceeded = component
        ? isResizeBeyondLimits(component, bp, start, { w: node.w, h: node.h })
        : false;
      setResizeLimitFeedback(el, exceeded);
    });
    grid.on('resizestop', (event, el) => {
      setResizeLimitFeedback(el, false);
      const snapshot = resizeSnapshot;
      resizeSnapshot = null;
      const node = el.gridstackNode;
      if (!node) return;
      const start = snapshot && snapshot[node.id];
      const snap = presetAfterResize(node.id, bp, start, { w: node.w, h: node.h })
        || nearestPreset(node.id, bp, node.w, node.h);
      const box = snap
        ? { x: Math.min(node.x, layout.columns - snap.w), y: node.y, w: snap.w, h: snap.h }
        : { x: node.x, y: node.y, w: node.w, h: node.h };
      grid.batchUpdate();
      if (snap) {
        node.preset = snap.name;
        el.dataset.layoutPreset = snap.name;
      }
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
    });

    return () => {
      grid.off('change');
      fitObserver.disconnect();
      window.removeEventListener('tokenmonitor:theme-applied', refitContent);
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
      .filter((item) => {
        const component = getComponent(item.id);
        return !component.requiresProvider
          || providers.some((provider) => provider.id === component.providerId);
      })
      .map((item) => {
        const component = getComponent(item.id);
        return (
          <section
            key={item.id}
            className={'component-wrapper grid-stack-item ' + component.itemClass}
            data-component-id={item.id}
            data-layout-preset={item.preset}
            gs-id={item.id}
            gs-x={item.x}
            gs-y={item.y}
            gs-w={item.w}
            gs-h={item.h}
            gs-min-w={component.minSize.w}
            gs-min-h={component.minSize.h}
          >
            <div className="module-drag-handle" aria-hidden="true" />
            <div className={'grid-stack-item-content component-surface ' + component.surfaceClass}>
              {component.showTitle ? <div className="component-title">{component.label}</div> : null}
              <RegisteredWidgetBody id={item.id} onContentChange={() => { if (fitRef.current) fitRef.current(); }} />
            </div>
          </section>
        );
      });
  }, [ready, rebuildKey]);

  if (!ready) {
    return <div className="content"><div className="placeholder">加载中…</div></div>;
  }

  return (
    <div className="content">
      {USAGE_CHART_IDS.some((id) => visibleIds.has(id)) ? <ChartRangeToolbar /> : null}
      <div key={rebuildKey} className={'grid-stack' + (editing ? ' editing' : '')} ref={hostRef}>
        {gridChildren}
      </div>
    </div>
  );
}
