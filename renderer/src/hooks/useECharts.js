// useECharts(ref, buildOption, deps):挂载时 init 一次,数据变化时全量 setOption。
// 返回 { update } 供外部显式推送;ResizeObserver 自适应容器尺寸。
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export default function useECharts(ref, buildOption, deps) {
  const chartRef = useRef(null);

  useEffect(() => {
    const dom = ref.current;
    if (!dom) return;
    const chart = echarts.init(dom, null, { width: dom.clientWidth, height: dom.clientHeight });
    chartRef.current = chart;
    chart.setOption(buildOption());
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(dom);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [ref]);

  useEffect(() => {
    if (chartRef.current) chartRef.current.setOption(buildOption(), true);
  }, deps || []);

  return {
    update: (option) => {
      if (chartRef.current) chartRef.current.setOption(option, true);
    },
    resize: () => {
      if (chartRef.current) chartRef.current.resize();
    }
  };
}
