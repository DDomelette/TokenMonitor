const https = require('https');

function fetchBalance(apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.deepseek.com',
      path: '/user/balance',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.is_available !== undefined && data.balance_infos && data.balance_infos.length > 0) {
            const info = data.balance_infos[0];
            resolve({
              available: data.is_available,
              currency: info.currency,
              total: info.total_balance,
              granted: info.granted_balance,
              toppedUp: info.topped_up_balance
            });
          } else {
            resolve(null);
          }
        } catch (e) {
          reject(new Error('Failed to parse balance response'));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Balance request timeout')); });
    req.end();
  });
}

module.exports = { fetchBalance };
