const echarts = require('echarts');

function getTheme(isDark) {
  return {
    color: ['#4D6BFE', '#22C55E', '#F59E0B', '#EF4444', '#7B92FF'],
    backgroundColor: 'transparent',
    textStyle: {
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 10,
      color: isDark ? '#9CA3AF' : '#6B7280'
    },
    grid: {
      top: 12,
      right: 12,
      bottom: 8,
      left: 40,
      containLabel: false
    },
    xAxis: {
      type: 'time',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 9,
        color: isDark ? '#9CA3AF' : '#6B7280',
        formatter: (value) => {
          const d = new Date(value);
          return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
        }
      },
      splitLine: { show: false }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 9,
        color: isDark ? '#9CA3AF' : '#6B7280'
      },
      splitLine: {
        lineStyle: {
          color: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
          type: 'dashed'
        }
      }
    },
    tooltip: {
      backgroundColor: isDark ? 'rgba(30,32,38,0.95)' : 'rgba(255,255,255,0.95)',
      borderColor: isDark ? '#3A3C45' : '#E5E7EB',
      textStyle: {
        color: isDark ? '#E5E7EB' : '#1A1A2E',
        fontSize: 11
      }
    }
  };
}

function parseTokenValue(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;
  const num = parseInt(value, 10);
  return isNaN(num) ? 0 : num;
}

module.exports = { getTheme, parseTokenValue };
