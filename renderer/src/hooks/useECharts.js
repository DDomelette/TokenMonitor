// useECharts(ref, buildOption, deps):容器有非零尺寸时才 init(gridstack 布局前挂载时容器为 0x0),
// 尺寸变化时惰性补 init 或 resize;数据变化时全量 setOption。
// 返回 { update } 供外部显式推送;ResizeObserver 自适应容器尺寸。
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export default function useECharts(ref, buildOption, deps) {
  const chartRef = useRef(null);
  // 始终持有最新 buildOption,避免惰性 init 用到首帧闭包的旧数据
  const buildRef = useRef(buildOption);
  buildRef.current = buildOption;

  useEffect(() => {
    const dom = ref.current;
    if (!dom) return;
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
      }
    };
    ensure();
    const observer = new ResizeObserver(ensure);
    observer.observe(dom);
    return () => {
      observer.disconnect();
      if (chartRef.current) chartRef.current.dispose();
      chartRef.current = null;
    };
  }, [ref]);

  useEffect(() => {
    if (chartRef.current) chartRef.current.setOption(buildRef.current(), true);
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
