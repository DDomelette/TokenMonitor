// useECharts(ref, buildOption, deps):容器有非零尺寸时才 init(gridstack 布局前挂载时容器为 0x0),
// 尺寸变化时惰性补 init 或 resize;数据变化时增量合并 setOption。
// 鼠标查看图表时只暂存数据更新,离开后应用最新一份,避免悬浮提示被周期刷新打断。
// 尺寸稳定(150ms 无变化)后按新宽高重建 option:密度配置(字体/网格/标签间隔/hideOverlap)
// 是 build 时按当时宽高算死的,只 resize 不重建会导致坐标轴标签按旧尺寸被隐藏。
// 返回 { update } 供外部显式推送;ResizeObserver 自适应容器尺寸。
import { useEffect, useRef } from 'react';
import echarts from '../lib/echarts.js';

export default function useECharts(ref, buildOption, deps) {
  const chartRef = useRef(null);
  const applyDataRef = useRef(null);
  // 始终持有最新 buildOption,避免惰性 init 用到首帧闭包的旧数据
  const buildRef = useRef(buildOption);
  buildRef.current = buildOption;

  useEffect(() => {
    const dom = ref.current;
    if (!dom) return;
    let rebuildTimer = 0;
    let leaveTimer = 0;
    let interacting = false;
    let pendingData = false;

    const applyData = () => {
      if (!chartRef.current) return;
      if (interacting) {
        pendingData = true;
        return;
      }
      pendingData = false;
      // 平台筛选会减少 series，显式替换系列以避免合并更新留下旧曲线。
      chartRef.current.setOption(buildRef.current(), { replaceMerge: ['series'] });
    };
    applyDataRef.current = applyData;

    const onPointerEnter = () => {
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = 0;
      }
      interacting = true;
    };
    const onPointerLeave = () => {
      if (leaveTimer) clearTimeout(leaveTimer);
      // 短暂宽限避免指针经过图表边缘或悬浮层时立即重绘。
      leaveTimer = setTimeout(() => {
        leaveTimer = 0;
        interacting = false;
        if (pendingData) applyData();
      }, 300);
    };

    const ensure = () => {
      if (!chartRef.current) {
        if (dom.clientWidth <= 0 || dom.clientHeight <= 0) return;
        const chart = echarts.init(dom);
        chartRef.current = chart;
        // 调试钩子:CDP 下可读 dom.__chart.getOption() 核对实际生效的配置
        dom.__chart = chart;
        chart.setOption(buildRef.current());
      } else {
        chartRef.current.resize();
        if (rebuildTimer) clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => {
          rebuildTimer = 0;
          if (!chartRef.current) return;
          chartRef.current.setOption(buildRef.current(), true);
          chartRef.current.resize();
        }, 150);
      }
    };
    const onThemeApplied = () => {
      if (!chartRef.current) {
        ensure();
        return;
      }
      chartRef.current.setOption(buildRef.current(), true);
      chartRef.current.resize();
    };
    ensure();
    const observer = new ResizeObserver(ensure);
    observer.observe(dom);
    dom.addEventListener('pointerenter', onPointerEnter);
    dom.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('tokenmonitor:theme-applied', onThemeApplied);
    return () => {
      observer.disconnect();
      dom.removeEventListener('pointerenter', onPointerEnter);
      dom.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('tokenmonitor:theme-applied', onThemeApplied);
      if (rebuildTimer) clearTimeout(rebuildTimer);
      if (leaveTimer) clearTimeout(leaveTimer);
      applyDataRef.current = null;
      if (chartRef.current) chartRef.current.dispose();
      chartRef.current = null;
      delete dom.__chart;
    };
  }, [ref]);

  useEffect(() => {
    if (applyDataRef.current) applyDataRef.current();
  }, deps || []);

  return {
    update: (option) => {
      if (chartRef.current) chartRef.current.setOption(option);
    },
    resize: () => {
      if (chartRef.current) chartRef.current.resize();
    }
  };
}
