// DSH 平台仪表盘数据(纯函数,无 electron 依赖,可单测)。
// 输入为 store 键 'usageDaily' / 'usageDailyCost' 中 dsh: 前缀的日聚合,
// 输出与 deepseek stats 同构的最小结构,供 get:dashboard 复用 buildCurvePoints。

// 与 telemetrylog.MATCH 一致的日期形态校验:拒绝 usage-2026-13-99 之类非法日期键。
const DAY_KEY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DSH_PREFIX = 'dsh:';

// 从聚合对象提取 dsh: 前缀日行 → [{ date, total }],按 date 升序。
// 非 dsh 前缀、畸形日期键、非有限或 <= 0 的数值一律忽略。
function dshDailyList(aggregate, pickTotal) {
  const out = [];
  Object.keys(aggregate || {}).forEach((key) => {
    if (key.indexOf(DSH_PREFIX) !== 0) return;
    const date = key.slice(DSH_PREFIX.length);
    if (!DAY_KEY.test(date)) return;
    const total = pickTotal(aggregate[key]);
    if (!Number.isFinite(total) || total <= 0) return;
    out.push({ date, total });
  });
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

function buildDshDashboard(usageDaily, usageDailyCost) {
  const tokenDaily = dshDailyList(usageDaily, (v) => Number(v && v.total));
  const costDaily = dshDailyList(usageDailyCost, (v) => Number(v));
  let token = 0;
  let cost = 0;
  tokenDaily.forEach((d) => { token += d.total; });
  costDaily.forEach((d) => { cost += d.total; });
  return {
    tokenDaily,
    costDaily,
    aggregate: { token, cost }
  };
}

module.exports = { buildDshDashboard, dshDailyList };
