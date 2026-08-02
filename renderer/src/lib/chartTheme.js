// ECharts 主题(从 src/renderer/js/charts.js 的 getTheme 逐字迁移为 ESM)。
export function getTheme(isDark) {
  return {
    color: ['#74B8FC', '#22C55E', '#F59E0B', '#EF4444', '#95CAFF'],
    backgroundColor: 'transparent',
    textStyle: {
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 10,
      color: isDark ? '#9CA3AF' : '#6B7280'
    },
    grid: {
      top: 12,
      right: 12,
      bottom: 28,
      left: 52,
      containLabel: false
    },
    xAxis: {
      type: 'category',
      data: [],
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 9,
        color: isDark ? '#9CA3AF' : '#6B7280',
        interval: 'auto'
      },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 9,
        color: isDark ? '#9CA3AF' : '#6B7280',
        formatter: function (v) {
          if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
          if (v >= 1000) return (v / 1000).toFixed(0) + 'K';
          return v.toString();
        }
      },
      splitLine: {
        lineStyle: {
          color: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
          type: 'dashed'
        }
      }
    },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      confine: false,
      backgroundColor: isDark ? 'rgba(30,32,38,0.95)' : 'rgba(255,255,255,0.95)',
      borderColor: isDark ? '#3A3C45' : '#E5E7EB',
      textStyle: {
        color: isDark ? '#E5E7EB' : '#1A1A2E',
        fontSize: 11
      }
    }
  };
}

export function getBarTheme(isDark) {
  return {
    textColor: isDark ? '#9CA3AF' : '#6B7280',
    gridColor: isDark ? '#2A2C35' : '#F3F4F6',
    axisLineColor: isDark ? '#3A3C45' : '#E5E7EB'
  };
}
