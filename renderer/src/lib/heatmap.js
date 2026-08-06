// GitHub 风格 Token 活动热力图的纯函数(node 可测)。

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (date) => date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());

function parseLocalDay(value) {
  const match = typeof value === 'string' ? DATE_KEY_PATTERN.exec(value) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) return null;
  return date;
}

// 构造某年 53 列 × 7 行网格:每列 = 一周(周日起),每行 = 星期几。
// 首列为该年 1 月 1 日所在周的周日(可能落在前一年);最后一列补足到 7 天。
export function buildWeeks(year) {
  const start = new Date(year, 0, 1);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(year, 11, 31);
  const totalDays = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;

  const weeks = [];
  let d = 0;
  while (d < totalDays) {
    const date = new Date(start.getTime() + d * 86400000);
    const col = Math.floor(d / 7);
    const row = d % 7;
    if (!weeks[col]) weeks[col] = new Array(7);
    weeks[col][row] = {
      date: dayKey(date),
      inYear: date.getFullYear() === year
    };
    d += 1;
  }
  // 最后一列补足到 7 天(溢出到次年 1 月),保持 53 列满
  const lastCol = weeks.length - 1;
  while (weeks[lastCol].some((cell) => !cell)) {
    const date = new Date(start.getTime() + d * 86400000);
    const row = d % 7;
    weeks[lastCol][row] = {
      date: dayKey(date),
      inYear: date.getFullYear() === year
    };
    d += 1;
  }
  return weeks;
}

// 返回日期所在可视列的周日起始日。使用本地日历字段,与 buildWeeks 的周日至周六列一致。
export function sundayWeekKey(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const sunday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  sunday.setDate(sunday.getDate() - sunday.getDay());
  return dayKey(sunday);
}

// 将每日用量按热力图的周日至周六可视列聚合。跨年首列以真实周日为键,
// 但只会累加调用方传入的数据(所选年份的 API 快照不会自动引入上一年数据)。
export function buildSundayWeekTotals(days) {
  const totals = {};
  Object.keys(days || {}).forEach((dateKey) => {
    const total = Number(days[dateKey]) || 0;
    if (total <= 0) return;
    const date = parseLocalDay(dateKey);
    if (!date) return;
    const key = sundayWeekKey(date);
    totals[key] = (totals[key] || 0) + total;
  });
  return totals;
}

// 0 = 无消耗;1..4 按 value/maxDaily 四档均分(0.25 / 0.5 / 0.75)。
export function colorLevel(value, maxDaily) {
  const v = Number(value) || 0;
  if (v <= 0) return 0;
  const m = Number(maxDaily) || 0;
  if (m <= 0) return 0;
  const ratio = v / m;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

// token 数量显示:≥1e8 用亿(1 位小数),≥1e4 用万(千分位),否则千分位。
export function formatToken(n) {
  const value = Number(n) || 0;
  if (value >= 100000000) return (value / 100000000).toFixed(1) + '亿';
  if (value >= 10000) return (value / 10000).toLocaleString('en-US') + '万';
  return value.toLocaleString('en-US');
}

// 方块堆积列(每周/累计模式):列内方块数 ∝ 值,scale = 列最大值 / MAX_HEATMAP_BLOCKS
export const MAX_HEATMAP_BLOCKS = 10;

export function blockCount(value, scale) {
  const v = Number(value) || 0;
  const s = Number(scale) || 0;
  if (v <= 0 || s <= 0) return 0;
  return Math.max(1, Math.min(MAX_HEATMAP_BLOCKS, Math.round(v / s)));
}
