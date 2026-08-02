// GitHub 风格 Token 活动热力图的纯函数(node 可测)。

// 构造某年 53 列 × 7 行网格:每列 = 一周(周日起),每行 = 星期几。
// 首列为该年 1 月 1 日所在周的周日(可能落在前一年);最后一列补足到 7 天。
export function buildWeeks(year) {
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

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

// ISO 周年份(周一为每周第一天,用于"每周"聚合)。
export function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + weekNo;
}
