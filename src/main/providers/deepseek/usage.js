// DeepSeek 平台用量采集:从旧 src/main/fetcher.js 原样搬入(行为不变)。
// 唯一改动:host 由模块常量改为可构造注入(this.host),便于测试与多环境。
const https = require('https');

const PLATFORM_HOST = 'platform.deepseek.com';

function localTzSec() {
  return -new Date().getTimezoneOffset() * 60;
}

function localTodayStr() {
  return new Date(Date.now() + localTzSec() * 1000).toISOString().slice(0, 10);
}

function sumAll(usageList) {
  var total = 0;
  (usageList || []).forEach(function (u) { total += parseFloat(u.amount) || 0; });
  return total;
}

function getUsageMap(usageList) {
  var map = {};
  (usageList || []).forEach(function (u) { map[u.type] = parseFloat(u.amount) || 0; });
  return map;
}

function parseDailyData(days, sumFn) {
  if (!days || !Array.isArray(days)) return [];
  return days.map(function (d) {
    var dayTotal = 0;
    var models = [];
    var dayCacheHit = 0;
    var dayCacheMiss = 0;
    var dayCompletion = 0;

    (d.data || []).forEach(function (m) {
      var tokens = sumFn(m.usage || []);
      var usage = getUsageMap(m.usage);
      var mCacheHit = usage['PROMPT_CACHE_HIT_TOKEN'] || 0;
      var mCacheMiss = usage['PROMPT_CACHE_MISS_TOKEN'] || 0;
      var mCompletion = usage['RESPONSE_TOKEN'] || 0;

      dayTotal += tokens;
      dayCacheHit += mCacheHit;
      dayCacheMiss += mCacheMiss;
      dayCompletion += mCompletion;

      models.push({
        model: m.model,
        tokens: Math.round(tokens),
        cacheHit: Math.round(mCacheHit),
        cacheMiss: Math.round(mCacheMiss),
        completion: Math.round(mCompletion)
      });
    });

    return {
      date: d.date,
      total: dayTotal,
      cacheHit: Math.round(dayCacheHit),
      cacheMiss: Math.round(dayCacheMiss),
      completion: Math.round(dayCompletion),
      models: models.sort(function (a, b) { return b.tokens - a.tokens; })
    };
  });
}

function todayData(dailyData) {
  if (!dailyData || !dailyData.length) return null;
  var todayStr = localTodayStr();
  for (var i = dailyData.length - 1; i >= 0; i--) {
    if (dailyData[i].date === todayStr) return dailyData[i];
  }
  return null;
}

function parseCostData(data) {
  var bizData = data && data.data && data.data.biz_data;
  var root = Array.isArray(bizData) ? bizData[0] : bizData;
  if (!root) return { dailyData: [], aggregate: { totalCost: 0, todayCost: 0, models: [] } };

  var modelMap = {};
  var totalCost = 0;
  var days = parseDailyData(root.days, sumAll);

  (root.total || []).forEach(function (entry) {
    var cost = sumAll(entry.usage);
    modelMap[entry.model] = { model: entry.model, cost: cost };
    totalCost += cost;
  });

  var today = todayData(days);

  return {
    dailyData: days,
    aggregate: {
      totalCost: totalCost,
      todayCost: today ? today.total : 0,
      models: Object.values(modelMap).sort(function (a, b) { return b.cost - a.cost; })
    }
  };
}

function parseTokenData(data) {
  var bizData = data && data.data && data.data.biz_data;
  var root = Array.isArray(bizData) ? bizData[0] : bizData;
  if (!root) return { dailyData: [], aggregate: { totalTokens: 0, todayTokens: 0, cacheRate: 0, todayCacheRate: 0, cacheHit: 0, cacheMiss: 0, todayCacheHit: 0, todayCacheMiss: 0, models: [] } };

  var modelMap = {};
  var totalCacheHit = 0;
  var totalCacheMiss = 0;
  var totalTokens = 0;
  var days = parseDailyData(root.days, sumAll);

  (root.total || []).forEach(function (entry) {
    if (!entry.model || !entry.usage) return;
    var tokens = Math.round(sumAll(entry.usage));
    modelMap[entry.model] = { model: entry.model, tokens: tokens };
    totalTokens += tokens;
    var usage = getUsageMap(entry.usage);
    totalCacheHit += usage['PROMPT_CACHE_HIT_TOKEN'] || 0;
    totalCacheMiss += usage['PROMPT_CACHE_MISS_TOKEN'] || 0;
  });

  var inputTokens = totalCacheHit + totalCacheMiss;
  var cacheRate = (inputTokens > 0) ? (totalCacheHit / inputTokens * 100) : 0;

  var today = todayData(days);
  var todayInput = (today ? today.cacheHit + today.cacheMiss : 0);
  var todayRate = (todayInput > 0) ? (today.cacheHit / todayInput * 100) : 0;

  return {
    dailyData: days,
    aggregate: {
      totalTokens: totalTokens,
      todayTokens: today ? today.total : 0,
      cacheRate: cacheRate,
      todayCacheRate: todayRate,
      cacheHit: Math.round(totalCacheHit),
      cacheMiss: Math.round(totalCacheMiss),
      todayCacheHit: today ? today.cacheHit : 0,
      todayCacheMiss: today ? today.cacheMiss : 0,
      models: Object.values(modelMap).sort(function (a, b) { return b.tokens - a.tokens; })
    }
  };
}

class UsageFetcher {
  constructor(host) {
    this.host = host || PLATFORM_HOST;
  }

  httpGet(sessionToken, path) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        path: path,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${sessionToken}`,
          'Accept': 'application/json',
          'x-app-version': '1.0.0'
        },
        rejectUnauthorized: true
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error('Unauthorized: session expired (HTTP ' + res.statusCode + ')'));
            return;
          }
          try {
            const data = JSON.parse(body);
            if (data.code && data.msg) {
              reject(new Error(data.msg));
              return;
            }
            resolve(data);
          } catch (e) {
            reject(new Error('Failed to parse response'));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }

  fetchUsageCost(sessionToken, month, year) {
    return this.httpGet(sessionToken, `/api/v0/usage/cost?month=${month}&year=${year}`)
      .then(parseCostData);
  }

  fetchUsageAmount(sessionToken, month, year) {
    return this.httpGet(sessionToken, `/api/v0/usage/amount?month=${month}&year=${year}`)
      .then(parseTokenData);
  }

  // Fetches the given month; if it has no usage at all, falls back to the previous month
  // (handles the month-start window where the current month is still empty).
  async fetchUsageWithFallback(sessionToken, month, year) {
    var cost = await this.fetchUsageCost(sessionToken, month, year);
    var amount = await this.fetchUsageAmount(sessionToken, month, year);
    if (cost.aggregate.totalCost === 0 && amount.aggregate.totalTokens === 0) {
      var prev = new Date(year, month - 2, 1);
      var prevMonth = prev.getMonth() + 1;
      var prevYear = prev.getFullYear();
      var prevCost = await this.fetchUsageCost(sessionToken, prevMonth, prevYear);
      var prevAmount = await this.fetchUsageAmount(sessionToken, prevMonth, prevYear);
      return { cost: prevCost, amount: prevAmount, month: prevMonth, year: prevYear, fellBack: true };
    }
    return { cost: cost, amount: amount, month: month, year: year, fellBack: false };
  }
}

module.exports = { UsageFetcher, PLATFORM_HOST, parseCostData, parseTokenData, localTodayStr, localTzSec };
