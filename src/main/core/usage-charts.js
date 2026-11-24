// 四张用量图表的统一日聚合模型。
// 输入沿用本地 usageDaily / usageDailyCost；DeepSeek 当月官网快照只作为最新覆盖层，
// 不在渲染层重复请求或各自累计。所有输出日期均为北京时间日键并逐日零填充。
const { addBeijingDays, beijingDayKey, isValidBeijingDayKey } = require('./beijing-calendar');

const PROVIDERS = [
  { id: 'codex', name: 'Codex' },
  { id: 'kimi', name: 'Kimi' },
  { id: 'deepseek', name: 'DeepSeek' }
];
const RANGE_DAYS = new Set([7, 30, 90]);
const MAX_MODEL_SERIES = 4;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDays(value) {
  const days = Number(value);
  return RANGE_DAYS.has(days) ? days : 30;
}

function dayList(today, days) {
  const end = isValidBeijingDayKey(today) ? today : beijingDayKey();
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(addBeijingDays(end, -i));
  return { start: dates[0], end, dates };
}

function officialByDate(list, valueField) {
  const result = Object.create(null);
  (Array.isArray(list) ? list : []).forEach((row) => {
    if (!row || !isValidBeijingDayKey(row.date)) return;
    result[row.date] = {
      date: row.date,
      total: Math.max(0, number(row.total)),
      cached: Math.max(0, number(row.cacheHit)),
      models: (Array.isArray(row.models) ? row.models : []).map((model) => ({
        model: String(model && model.model ? model.model : '未记录模型'),
        tokens: Math.max(0, number(model && model.tokens))
      })).filter((model) => model.tokens > 0),
      valueField
    };
  });
  return result;
}

function storedRecord(usageDaily, providerId, date) {
  const row = usageDaily && usageDaily[providerId + ':' + date];
  return row && typeof row === 'object' ? row : null;
}

function summarize(daily) {
  let total = 0;
  let peak = 0;
  const cumulative = daily.map((value) => {
    total += number(value);
    peak = Math.max(peak, number(value));
    return total;
  });
  return {
    daily,
    cumulative,
    total,
    peak,
    average: daily.length ? total / daily.length : 0
  };
}

function modelSeries(modelRows, deepseekDaily) {
  const totals = new Map();
  modelRows.forEach((models) => {
    models.forEach((model) => {
      totals.set(model.model, (totals.get(model.model) || 0) + model.tokens);
    });
  });
  const topNames = Array.from(totals.entries())
    .filter((entry) => entry[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_MODEL_SERIES)
    .map((entry) => entry[0]);
  const selected = new Set(topNames);
  const series = topNames.map((name) => ({
    id: name,
    name,
    data: modelRows.map((models) => {
      const found = models.find((model) => model.model === name);
      return found ? found.tokens : 0;
    })
  }));
  const other = modelRows.map((models, index) => {
    const known = models.reduce((sum, model) => sum + model.tokens, 0);
    const unclassified = Math.max(0, deepseekDaily[index] - known);
    return models.reduce((sum, model) => sum + (selected.has(model.model) ? 0 : model.tokens), unclassified);
  });
  if (other.some((value) => value > 0) || series.length === 0) {
    series.push({ id: '__other__', name: topNames.length ? '其他' : '未记录模型', data: other });
  }
  return series;
}

function buildUsageCharts(options) {
  const opts = options || {};
  const days = normalizeDays(opts.days);
  const range = dayList(opts.today, days);
  const usageDaily = opts.usageDaily || {};
  const usageDailyCost = opts.usageDailyCost || {};
  const stats = opts.deepseekStats || {};
  const officialTokens = officialByDate(stats.tokenDaily, 'tokens');
  const officialCosts = officialByDate(stats.costDaily, 'cost');
  const providerValues = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, []]));
  const deepseekDaily = [];
  const allDaily = [];
  const costDaily = [];
  const modelRows = [];

  range.dates.forEach((date) => {
    let all = 0;
    let deepseekRecord = null;
    PROVIDERS.forEach((provider) => {
      const official = provider.id === 'deepseek' ? officialTokens[date] : null;
      const stored = storedRecord(usageDaily, provider.id, date);
      const record = official || stored;
      const value = Math.max(0, number(record && record.total));
      providerValues[provider.id].push(value);
      all += value;
      if (provider.id === 'deepseek') deepseekRecord = record;
    });
    deepseekDaily.push(deepseekRecord ? Math.max(0, number(deepseekRecord.total)) : 0);
    allDaily.push(all);
    modelRows.push((deepseekRecord && Array.isArray(deepseekRecord.models) ? deepseekRecord.models : []).map((model) => ({
      model: String(model && model.model ? model.model : '未记录模型'),
      tokens: Math.max(0, number(model && model.tokens))
    })).filter((model) => model.tokens > 0));

    const officialCost = Object.prototype.hasOwnProperty.call(officialCosts, date)
      ? officialCosts[date].total
      : null;
    const storedCost = usageDailyCost['deepseek:' + date];
    costDaily.push(Math.max(0, number(officialCost === null ? storedCost : officialCost)));
  });

  return {
    range: { days, start: range.start, end: range.end },
    dates: range.dates,
    source: { aggregation: 'usageDaily', timezone: 'Asia/Shanghai', grain: 'day' },
    providers: PROVIDERS.map((provider) => ({
      id: provider.id,
      name: provider.name,
      data: providerValues[provider.id]
    })),
    models: modelSeries(modelRows, deepseekDaily),
    allTokens: summarize(allDaily),
    deepseekTokens: summarize(deepseekDaily),
    deepseekCost: summarize(costDaily)
  };
}

module.exports = { buildUsageCharts, normalizeDays, summarize };
