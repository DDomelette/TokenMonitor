// 合并多条费用曲线点列为单条曲线(纯函数,无 React/ECharts 依赖,可单测)。
// 背景:cost-line 费用增长趋势原先只画 deepseek 平台曲线;DSH 本地遥测费用加入后,
// 需要把两条曲线按日合并——同日 deltaCost 求和,再按时间升序重算累计 totalCost。
// 输入:若干点列,每点形如 { time, totalCost, deltaCost, ... }(token 字段不需要);
// 输出:[{ time, totalCost, deltaCost }] 按 time 升序;空输入/全空列返回 []。

import { beijingDayKey, beijingMonthDayLabel } from './beijing-calendar.js';

export function curvePointLabels(points) {
  return (points || []).map((point) => beijingMonthDayLabel(point && point.time));
}

export function mergeCurves(curves) {
  const deltaByDay = new Map();
  (curves || []).forEach((points) => {
    (points || []).forEach((p) => {
      const t = Number(p && p.time);
      if (!Number.isFinite(t)) return;
      const key = beijingDayKey(t);
      if (!key) return;
      deltaByDay.set(key, (deltaByDay.get(key) || 0) + (Number(p.deltaCost) || 0));
    });
  });

  const days = Array.from(deltaByDay.keys()).sort();
  const out = [];
  let cumulative = 0;
  days.forEach((day) => {
    const delta = deltaByDay.get(day);
    cumulative += delta;
    const [y, m, d] = day.split('-').map(Number);
    out.push({ time: Date.UTC(y, m - 1, d), totalCost: cumulative, deltaCost: delta });
  });
  return out;
}

export default mergeCurves;
