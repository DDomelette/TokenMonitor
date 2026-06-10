const https = require('https');

const PLATFORM_HOST = 'platform.deepseek.com';

function fetchUsageCost(sessionToken, month, year) {
  return new Promise((resolve, reject) => {
    const path = `/api/v0/usage/cost?month=${month}&year=${year}`;
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
          const bizData = data && data.data && data.data.biz_data;
          if (bizData) {
            var entryCount = bizData.length;
            var sample = bizData[0] ? JSON.stringify(bizData[0]).slice(0, 600) : 'empty';
            console.log('[fetcher] biz_data entries:', entryCount, 'first entry keys:', Object.keys(bizData[0] || {}).join(','), 'sample:', sample);
          }
          resolve(parseUsageData(data));
        } catch (e) {
          reject(new Error('Failed to parse usage response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Usage request timeout')); });
    req.end();
  });
}

function fetchUsageAmount(sessionToken, month, year) {
  return new Promise((resolve, reject) => {
    const path = `/api/v0/usage/amount?month=${month}&year=${year}`;
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
          const bizData = data && data.data && data.data.biz_data;
          if (bizData) {
            var entryCount = bizData.length;
            var sample = bizData[0] ? JSON.stringify(bizData[0]).slice(0, 600) : 'empty';
            console.log('[amount] biz_data entries:', entryCount, 'sample:', sample);
          }
          resolve(data);
        } catch (e) {
          reject(new Error('Failed to parse usage response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Usage request timeout')); });
    req.end();
  });
}

function parseUsageData(data) {
  const modelMap = {};
  let totalCost = 0;

  const bizData = data && data.data && data.data.biz_data;
  if (bizData && Array.isArray(bizData)) {
    bizData.forEach(dayItem => {
      const models = dayItem && dayItem.total;
      if (!models || !Array.isArray(models)) return;

      models.forEach(entry => {
        if (!entry.model || !entry.usage || !Array.isArray(entry.usage)) return;

        if (!modelMap[entry.model]) {
          modelMap[entry.model] = {
            model: entry.model,
            promptTokens: 0,
            cacheHit: 0,
            cacheMiss: 0,
            completionTokens: 0
          };
        }

        const m = modelMap[entry.model];
        entry.usage.forEach(u => {
          const amt = parseFloat(u.amount) || 0;
          switch (u.type) {
            case 'PROMPT_TOKEN': m.promptTokens += amt; break;
            case 'PROMPT_CACHE_HIT_TOKEN': m.cacheHit += amt; break;
            case 'PROMPT_CACHE_MISS_TOKEN': m.cacheMiss += amt; break;
            case 'RESPONSE_TOKEN': m.completionTokens += amt; break;
            default: if (u.type && u.type.includes('COST')) totalCost += amt; break;
          }
        });
      });
    });
  }

  const models = Object.values(modelMap);
  let totalPromptTokens = 0;
  let totalCacheHit = 0;
  let totalCacheMiss = 0;
  let totalCompletionTokens = 0;

  models.forEach(m => {
    m.totalTokens = Math.round(m.promptTokens + m.cacheHit + m.cacheMiss + m.completionTokens);
    totalPromptTokens += m.promptTokens;
    totalCacheHit += m.cacheHit;
    totalCacheMiss += m.cacheMiss;
    totalCompletionTokens += m.completionTokens;
  });

  const inputTokens = totalPromptTokens + totalCacheHit + totalCacheMiss;
  const cacheRate = (inputTokens > 0) ? (totalCacheHit / inputTokens * 100) : 0;

  return {
    models: models.filter(m => m.totalTokens > 0).sort((a, b) => b.totalTokens - a.totalTokens),
    totalTokens: Math.round(inputTokens + totalCompletionTokens),
    totalCost: totalCost || 0,
    cacheRate: cacheRate,
    cacheHit: Math.round(totalCacheHit),
    cacheMiss: Math.round(totalCacheMiss),
    totalPromptTokens: Math.round(inputTokens),
    totalCompletionTokens: Math.round(totalCompletionTokens)
  };
}

module.exports = { fetchUsageCost, fetchUsageAmount, parseUsageData };
