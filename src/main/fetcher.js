const https = require('https');

const PLATFORM_HOST = 'platform.deepseek.com';

function httpGet(sessionToken, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: PLATFORM_HOST,
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

function fetchUsageCost(sessionToken, month, year) {
  return httpGet(sessionToken, `/api/v0/usage/cost?month=${month}&year=${year}`)
    .then(parseCostData);
}

function fetchUsageAmount(sessionToken, month, year) {
  return httpGet(sessionToken, `/api/v0/usage/amount?month=${month}&year=${year}`)
    .then(function (data) {
      console.log('[amount-raw] top keys:', Object.keys(data).join(','));
      if (data.data) console.log('[amount-raw] data keys:', Object.keys(data.data).join(','));
      if (data.data && data.data.biz_data && data.data.biz_data[0]) {
        console.log('[amount-raw] biz_data[0] keys:', Object.keys(data.data.biz_data[0]).join(','));
        console.log('[amount-raw] first day sample:', JSON.stringify(data.data.biz_data[0].days ? data.data.biz_data[0].days[0] : 'no days').slice(0, 600));
      }
      return parseTokenData(data);
    });
}

function sumUsage(usageList) {
  var prompt = 0, cacheHit = 0, cacheMiss = 0, completion = 0;
  usageList.forEach(function (u) {
    var amt = parseFloat(u.amount) || 0;
    switch (u.type) {
      case 'PROMPT_TOKEN': prompt += amt; break;
      case 'PROMPT_CACHE_HIT_TOKEN': cacheHit += amt; break;
      case 'PROMPT_CACHE_MISS_TOKEN': cacheMiss += amt; break;
      case 'RESPONSE_TOKEN': completion += amt; break;
    }
  });
  return { prompt: prompt, cacheHit: cacheHit, cacheMiss: cacheMiss, completion: completion, total: prompt + cacheHit + cacheMiss + completion };
}

function parseDailyData(bizData) {
  if (!bizData || !bizData[0] || !bizData[0].days) return [];

  var days = bizData[0].days;
  return days.map(function (d) {
    var models = [];
    var dayTotal = 0;

    (d.data || []).forEach(function (m) {
      var usage = sumUsage(m.usage || []);
      dayTotal += usage.total;
      models.push({
        model: m.model,
        tokens: Math.round(usage.total),
        prompt: Math.round(usage.prompt),
        cacheHit: Math.round(usage.cacheHit),
        cacheMiss: Math.round(usage.cacheMiss),
        completion: Math.round(usage.completion)
      });
    });

    return {
      date: d.date,
      total: Math.round(dayTotal),
      models: models.sort(function (a, b) { return b.tokens - a.tokens; })
    };
  });
}

function parseCostData(data) {
  var bizData = data && data.data && data.data.biz_data;
  if (!bizData || !bizData[0]) {
    return { dailyData: [], aggregate: { totalCost: 0, models: [], cacheRate: 0, cacheHit: 0, cacheMiss: 0 } };
  }

  var dailyData = parseDailyData(bizData);

  var modelMap = {};
  var totalCost = 0;

  (bizData[0].total || []).forEach(function (entry) {
    if (!modelMap[entry.model]) {
      modelMap[entry.model] = { model: entry.model, cost: 0 };
    }
    (entry.usage || []).forEach(function (u) {
      var amt = parseFloat(u.amount) || 0;
      modelMap[entry.model].cost += amt;
      totalCost += amt;
    });
  });

  return {
    dailyData: dailyData,
    aggregate: {
      totalCost: totalCost,
      models: Object.values(modelMap).sort(function (a, b) { return b.cost - a.cost; })
    }
  };
}

function parseTokenData(data) {
  var bizData = data && data.data && data.data.biz_data;
  if (!bizData || !bizData[0]) {
    return { dailyData: [], aggregate: { totalTokens: 0, cacheRate: 0, cacheHit: 0, cacheMiss: 0, models: [] } };
  }

  var dailyData = parseDailyData(bizData);

  var modelMap = {};
  var totalCacheHit = 0;
  var totalCacheMiss = 0;
  var totalTokens = 0;

  (bizData[0].total || []).forEach(function (entry) {
    if (!entry.model || !entry.usage) return;
    if (!modelMap[entry.model]) {
      modelMap[entry.model] = { model: entry.model, tokens: 0 };
    }
    entry.usage.forEach(function (u) {
      var amt = parseFloat(u.amount) || 0;
      modelMap[entry.model].tokens += Math.round(amt);
      switch (u.type) {
        case 'PROMPT_CACHE_HIT_TOKEN': totalCacheHit += amt; break;
        case 'PROMPT_CACHE_MISS_TOKEN': totalCacheMiss += amt; break;
      }
      totalTokens += Math.round(amt);
    });
  });

  var inputTokens = totalCacheHit + totalCacheMiss;
  var cacheRate = (inputTokens > 0) ? (totalCacheHit / inputTokens * 100) : 0;

  return {
    dailyData: dailyData,
    aggregate: {
      totalTokens: totalTokens,
      cacheRate: cacheRate,
      cacheHit: Math.round(totalCacheHit),
      cacheMiss: Math.round(totalCacheMiss),
      models: Object.values(modelMap).sort(function (a, b) { return b.tokens - a.tokens; })
    }
  };
}

module.exports = { fetchUsageCost, fetchUsageAmount };
