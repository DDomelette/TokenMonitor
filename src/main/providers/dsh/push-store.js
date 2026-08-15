// 把 ingest 记录写入 push 聚合存储。与 batch 注册表/source 状态在同一快照提交,
// 避免 "已记账但未确认" 或 "已确认但未记账" 的中间状态。
const { rollupDshRecords } = require('./usage-records');
const {
  PUSH_USAGE_KEY, PUSH_COST_KEY, mergeDshKeys, mergeDshCosts
} = require('../../core/dsh-usage-merge');
const { filterUsageDaily } = require('../../core/usage-retention');

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function setNested(target, key, value) {
  const parts = key.split('.');
  let current = target;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[0]] = value;
}

function commitDshPushRecords(store, records, options = {}) {
  const diagnostics = options.diagnostics || {};
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  const retainAll = options.retainAll === true;
  const extraWrites = options.extraWrites && typeof options.extraWrites === 'object' ? options.extraWrites : {};

  const rolled = rollupDshRecords(records, diagnostics, nowMs);
  const historyDays = store && typeof store.get === 'function' ? store.get('data.historyDays') : undefined;
  const usageDailyAdd = retainAll ? rolled.usageDaily : filterUsageDaily(rolled.usageDaily, historyDays, nowMs);
  const usageDailyCostAdd = retainAll ? rolled.usageDailyCost : filterUsageDaily(rolled.usageDailyCost, historyDays, nowMs);
  const usageDaily = mergeDshKeys(store.get('usageDailyPush'), usageDailyAdd);
  const usageDailyCost = mergeDshCosts(store.get('usageDailyCostPush'), usageDailyCostAdd);

  const snapshot = store && store.store;
  if (snapshot && typeof snapshot === 'object') {
    const copy = cloneValue(snapshot);
    copy[PUSH_USAGE_KEY] = usageDaily;
    copy[PUSH_COST_KEY] = usageDailyCost;
    Object.keys(extraWrites).forEach((key) => { setNested(copy, key, extraWrites[key]); });
    store.store = copy;
  } else {
    const writes = {
      [PUSH_USAGE_KEY]: usageDaily,
      [PUSH_COST_KEY]: usageDailyCost
    };
    Object.keys(extraWrites).forEach((key) => { writes[key] = extraWrites[key]; });
    store.set(writes);
  }
  return { records, usageDaily, usageDailyCost };
}

module.exports = { commitDshPushRecords };
