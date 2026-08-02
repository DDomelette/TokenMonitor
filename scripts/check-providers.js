// 一次性自检:真实凭证跑 codex/kimi fetchQuota,打印归一化结果(与 CLI 显示对照;绝不打印 token)。
const { httpGet } = require('../src/main/core/http');
const codex = require('../src/main/providers/codex');
const kimi = require('../src/main/providers/kimi');

const PROXY = 'http://127.0.0.1:7890';

function ctxFor(providerId) {
  return {
    store: {
      get: (k) => (k === 'providers.proxyUrl' ? PROXY : undefined)
    },
    httpGet: httpGet,
    getProxyUrl: () => PROXY,
    logger: console
  };
}

(async function () {
  console.log('==== codex authStatus:', codex.authStatus(ctxFor('codex')));
  try {
    const quota = await codex.fetchQuota(ctxFor('codex'));
    console.log('codex quota:', JSON.stringify(quota, null, 2).slice(0, 800));
  } catch (e) {
    console.log('codex fetchQuota error:', e.message);
  }

  console.log('==== kimi authStatus:', kimi.authStatus(ctxFor('kimi')));
  try {
    const quota = await kimi.fetchQuota(ctxFor('kimi'));
    console.log('kimi quota:', JSON.stringify(quota, null, 2).slice(0, 800));
  } catch (e) {
    console.log('kimi fetchQuota error:', e.message);
  }
})();
