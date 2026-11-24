// 无 DOM 时提供默认主题；浏览器中通过 getSemanticChartTheme() 读取 palette.css 的注册色。
export const PROVIDER_META = Object.freeze({
  deepseek: { label: 'DeepSeek', color: '#6E94F5', colorToken: '--provider-deepseek' },
  codex: { label: 'Codex', color: '#F2A05C', colorToken: '--provider-codex' },
  kimi: { label: 'Kimi', color: '#4ECB94', colorToken: '--provider-kimi' },
  dsh: { label: 'DeepSeek Harness', shortLabel: 'Harness', color: '#A78BFA', colorToken: '--provider-dsh' }
});

const DEFAULT_MODEL_COLORS = ['#5B8DEF', '#14B8A6', '#F59E0B', '#8B5CF6', '#94A3B8'];

// CSS/SVG 消费平台识别色时直接引用注册表，无需为换主题重建组件。
export function providerColor(providerId) {
  const meta = PROVIDER_META[providerId];
  return meta ? 'var(' + meta.colorToken + ')' : 'var(--primary)';
}

export function getTheme(isDark, palette) {
  const theme = {
    color: ['#74B8FC', '#22C55E', '#F59E0B', '#EF4444', '#95CAFF'],
    backgroundColor: 'transparent',
    textStyle: {
      fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      fontSize: 10,
      color: isDark ? '#9CA3AF' : '#6B7280'
    },
    grid: { top: 12, right: 12, bottom: 28, left: 52, containLabel: false },
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
    // 仅作样式源；真实消费方覆盖 tooltip 的定位与行为。
    tooltip: {
      trigger: 'axis',
      backgroundColor: isDark ? 'rgba(30,32,38,0.95)' : 'rgba(255,255,255,0.95)',
      borderColor: isDark ? '#3A3C45' : '#E5E7EB',
      textStyle: { color: isDark ? '#E5E7EB' : '#1A1A2E', fontSize: 11 }
    }
  };
  if (!palette) return theme;
  theme.textStyle.color = palette.textColor;
  theme.tooltip.backgroundColor = palette.tooltipBg;
  theme.tooltip.borderColor = palette.tooltipBorder;
  theme.tooltip.textStyle.color = palette.tooltipText;
  return theme;
}

export function getBarTheme(isDark, palette) {
  if (palette) {
    return {
      textColor: palette.textColor,
      gridColor: palette.gridColor,
      axisLineColor: palette.axisLineColor
    };
  }
  return {
    textColor: isDark ? '#9CA3AF' : '#6B7280',
    gridColor: isDark ? '#2A2C35' : '#F3F4F6',
    axisLineColor: isDark ? '#3A3C45' : '#E5E7EB'
  };
}

// styles 可注入 CSSStyleDeclaration，便于无浏览器测试；默认读取当前根节点的语义变量。
export function getSemanticChartTheme(isDark, styles) {
  const dark = isDark === true;
  const base = getTheme(dark);
  const bar = getBarTheme(dark);
  let computed = styles;
  if (computed === undefined && typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
    computed = getComputedStyle(document.documentElement);
  }
  const read = (token, fallback) => {
    const value = computed && typeof computed.getPropertyValue === 'function'
      ? computed.getPropertyValue(token).trim()
      : '';
    return value || fallback;
  };
  const providerColors = {};
  Object.entries(PROVIDER_META).forEach(([id, meta]) => {
    providerColors[id] = read(meta.colorToken, meta.color);
  });
  return {
    isDark: dark,
    primary: read('--primary', base.color[0]),
    primaryDark: read('--primary-dark', '#5A9FE0'),
    cost: read('--chart-cost', '#22A06B'),
    textColor: read('--text-secondary', bar.textColor),
    textPrimary: read('--text-primary', base.tooltip.textStyle.color),
    gridColor: read('--chart-grid', bar.gridColor),
    axisLineColor: read('--border', bar.axisLineColor),
    cursorColor: read('--chart-cursor', dark ? '#6B7280' : '#9CA3AF'),
    tooltipBg: read('--chart-tooltip-bg', base.tooltip.backgroundColor),
    tooltipBorder: read('--chart-tooltip-border', base.tooltip.borderColor),
    tooltipText: read('--chart-tooltip-text', base.tooltip.textStyle.color),
    providerColors,
    modelColors: DEFAULT_MODEL_COLORS.map((fallback, index) => read('--chart-model-' + (index + 1), fallback))
  };
}

// ECharts 的渐变在 Canvas 中解析，不能直接传 CSS 变量或 color-mix()。
export function colorWithAlpha(color, alpha) {
  const value = String(color || '').trim();
  const hex = value.match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  if (hex) {
    const normalized = hex[1].length === 3
      ? hex[1].split('').map((part) => part + part).join('')
      : hex[1];
    return 'rgba(' + [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16)).join(',') + ',' + alpha + ')';
  }
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/i);
  return rgb ? 'rgba(' + rgb[1] + ',' + rgb[2] + ',' + rgb[3] + ',' + alpha + ')' : value;
}
