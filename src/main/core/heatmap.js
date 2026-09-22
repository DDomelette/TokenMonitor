// 热力图数据 API:按 provider/年聚合每日 token 总量(纯函数可测)。
// usageDailyByProvider 形状:{ '<providerId>': { 'YYYY-MM-DD': totalTokens } }。
// Harness 是 DeepSeek 的客户端记录，不能与官网用量相加；仅单独查询时展示。
// provider 参数:'all' 按独立平台求和;其他值只取对应 provider。year 过滤日期前缀。
// 返回 { days: { 'YYYY-MM-DD': totalTokens }, maxDaily }(仅含有数据的日)。
function buildHeatmap(usageDailyByProvider, provider, year) {
  const days = {};
  const providers = provider === 'all' || !provider
    ? Object.keys(usageDailyByProvider || {}).filter((pid) => pid !== 'dsh')
    : [provider];
  (providers || []).forEach((pid) => {
    const daily = (usageDailyByProvider && usageDailyByProvider[pid]) || {};
    Object.keys(daily).forEach((date) => {
      if (year && !date.startsWith(String(year) + '-')) return;
      const total = Number(daily[date]) || 0;
      if (total > 0) days[date] = (days[date] || 0) + total;
    });
  });
  let maxDaily = 0;
  Object.keys(days).forEach((d) => {
    if (days[d] > maxDaily) maxDaily = days[d];
  });
  return { days: days, maxDaily: maxDaily };
}

module.exports = { buildHeatmap };
