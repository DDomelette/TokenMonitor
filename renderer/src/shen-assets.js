// 小深酱主题素材:透明 PNG 位于 renderer/public/shen/(构建时拷贝到 dist/shen/)。
// base './' 兼容 Electron file:// 加载与 Vite dev server。
const base = (import.meta.env && import.meta.env.BASE_URL) || './';

export const SHEN = {
  lying: base + 'shen/shen_lying.png',
  walk: base + 'shen/shen_walk_a.png',
  hike: base + 'shen/shen_walk_b.png',
  jog: base + 'shen/shen_run_c.png',
  run: base + 'shen/shen_run_a.png',
  sprint: base + 'shen/shen_run_b.png',
  hungry: base + 'shen/deepseek_chan_01_hungry.png',
  sleepy: base + 'shen/deepseek_chan_06_sleepy.png',
  heart: base + 'shen/deepseek_chan_09_heart.png',
  coding: base + 'shen/deepseek_chan_10_coding.png',
  salute: base + 'shen/deepseek_chan_02_salute.png'
};

// 步态映射:额度条显示的是"剩余百分比",剩余越多小深酱越悠闲,快用完时冲刺。
// 返回 { key, src, cls } —— cls 控制颠簸动画频率(跑得越快颠簸越急)。
export function gaitForRemaining(percent, empty) {
  if (empty || percent <= 5) return { key: 'sprint', src: SHEN.sprint, cls: 'g-sprint' };
  if (percent <= 40) return { key: 'run', src: SHEN.run, cls: 'g-run' };
  if (percent <= 60) return { key: 'jog', src: SHEN.jog, cls: 'g-jog' };
  if (percent <= 80) return { key: 'hike', src: SHEN.hike, cls: 'g-hike' };
  return { key: 'walk', src: SHEN.walk, cls: 'g-walk' };
}
