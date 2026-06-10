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
          console.log('[fetcher] raw API response sample:', JSON.stringify(data).slice(0, 500));
          if (data.code && data.msg) {
            reject(new Error(data.msg));
            return;
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
  const models = [];
  let totalTokens = 0;
  let totalCacheHit = 0;
  let totalCacheMiss = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalRequests = 0;
  let totalCost = 0;

  if (data && data.data && Array.isArray(data.data)) {
    data.data.forEach(dayItem => {
      if (dayItem && dayItem.models) {
        dayItem.models.forEach(modelGroup => {
          if (modelGroup && modelGroup.model && modelGroup.usage) {
            const modelTokens = { prompt: 0, cacheHit: 0, cacheMiss: 0, completion: 0, requests: 0 };
            const amounts = {};

            modelGroup.usage.forEach(u => {
              const amt = parseFloat(u.amount) || 0;
              amounts[u.type] = amt;

              switch (u.type) {
                case 'PROMPT_TOKEN': modelTokens.prompt = amt; break;
                case 'PROMPT_CACHE_HIT_TOKEN': modelTokens.cacheHit = amt; break;
                case 'PROMPT_CACHE_MISS_TOKEN': modelTokens.cacheMiss = amt; break;
                case 'RESPONSE_TOKEN': modelTokens.completion = amt; break;
                case 'REQUEST': modelTokens.requests = Math.floor(amt); break;
                default: if (u.type && u.type.includes('COST')) totalCost += amt; break;
              }
            });

            totalPromptTokens += modelTokens.prompt;
            totalCacheHit += modelTokens.cacheHit;
            totalCacheMiss += modelTokens.cacheMiss;
            totalCompletionTokens += modelTokens.completion;
            totalRequests += modelTokens.requests;

            const modelTotal = modelTokens.prompt + modelTokens.cacheHit + modelTokens.cacheMiss + modelTokens.completion;
            totalTokens += modelTotal;

            models.push({
              model: modelGroup.model,
              totalTokens: modelTotal,
              promptTokens: modelTokens.prompt,
              completionTokens: modelTokens.completion,
              cacheHit: modelTokens.cacheHit,
              cacheMiss: modelTokens.cacheMiss
            });
          }
        });
      }
    });
  }

  const cacheRate = (totalPromptTokens > 0) ? (totalCacheHit / totalPromptTokens * 100) : 0;

  return {
    models: models.sort((a, b) => b.totalTokens - a.totalTokens),
    totalTokens: Math.round(totalTokens),
    totalCost: totalCost || 0,
    cacheRate: cacheRate,
    cacheHit: Math.round(totalCacheHit),
    cacheMiss: Math.round(totalCacheMiss),
    totalPromptTokens: Math.round(totalPromptTokens),
    totalCompletionTokens: Math.round(totalCompletionTokens)
  };
}

module.exports = { fetchUsageCost, fetchUsageAmount, parseUsageData };
