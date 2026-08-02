// 纯函数(渲染层共用,node 侧可测)。
// 额度窗口重置时间文案:<24h 倒计时,≥24h 绝对时间;已过/无效返回空文案。
export function formatReset(resetsAt, now) {
  const target = resetsAt ? new Date(resetsAt).getTime() : NaN;
  if (!Number.isFinite(target)) return '';
  const nowMs = now || Date.now();
  const diff = target - nowMs;
  if (diff <= 0) return '已重置';

  const totalMin = Math.max(1, Math.floor(diff / 60000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;

  if (diff < 24 * 3600 * 1000) {
    if (hours > 0) return hours + '小时' + minutes + '分后重置';
    return minutes + '分钟后重置';
  }

  const d = new Date(target);
  const pad = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' 重置';
}

// token 数量显示:亿/万/千分位之外的最小格式(与热力图 formatToken 区分)。
export function formatTokenCount(n) {
  const value = Number(n) || 0;
  if (value >= 100000000) return (value / 100000000).toFixed(1) + '亿';
  if (value >= 10000) return (value / 10000).toFixed(1) + '万';
  return value.toLocaleString('en-US');
}
