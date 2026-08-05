// DeepSeek 余额采集:网络传输统一委托给主进程 HTTP 客户端。
const { httpGet: defaultHttpGet } = require('../../core/http');

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const BALANCE_TIMEOUTS = Object.freeze({ requestTimeoutMs: 10000 });

function parseBalanceData(data) {
  if (
    data
    && data.is_available !== undefined
    && Array.isArray(data.balance_infos)
    && data.balance_infos.length > 0
  ) {
    const info = data.balance_infos[0];
    return {
      available: data.is_available,
      currency: info.currency,
      total: info.total_balance,
      granted: info.granted_balance,
      toppedUp: info.topped_up_balance
    };
  }

  if (data && data.error) {
    throw new Error(
      (data.error && data.error.message) || 'Balance request failed'
    );
  }

  return null;
}

async function fetchBalance(apiKey, options = {}) {
  const request = options.httpGet || defaultHttpGet;
  try {
    const data = await request(
      BALANCE_URL,
      {
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      options.proxyUrl || null,
      BALANCE_TIMEOUTS
    );
    return parseBalanceData(data);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const authMatch = /Unauthorized:.*HTTP\s+(401|403)/i.exec(message);
    if (authMatch) {
      throw new Error('Unauthorized: invalid API key (HTTP ' + authMatch[1] + ')');
    }
    if (message === 'Failed to parse response') {
      throw new Error('Failed to parse balance response');
    }
    throw error;
  }
}

module.exports = { fetchBalance, parseBalanceData };
