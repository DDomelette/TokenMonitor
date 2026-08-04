// 多 Provider 调度器:每 provider 按 capability 独立定时器轮询 usage/quota/balance。
// 401/403/expired 类错误 → authStatus='expired' → broadcast('providers:changed', 全量快照)。
const { httpGet } = require('./http');

const DEFAULT_INTERVALS = { usage: 10 * 1000, quota: 60 * 1000, balance: 60 * 1000, localLog: 60 * 1000 };

function isAuthError(err) {
  const msg = (err && (err.message || String(err))) || '';
  return /unauthoriz|401|403|登录|expired|invalid token/i.test(msg);
}

function startScheduler({ registry, store, broadcast, intervals, onStateChange }) {
  const enabled = intervals === false ? false : Object.assign({}, DEFAULT_INTERVALS, intervals || {});
  const timers = [];
  const states = Object.create(null);
  const inflight = new Set();

  function getProxyUrl() {
    return store.get('providers.proxyUrl') || null;
  }

  function ctxFor(provider) {
    return {
      store: store,
      httpGet: httpGet,
      getProxyUrl: getProxyUrl,
      logger: console
    };
  }

  function broadcastAll() {
    broadcast('providers:changed', getSnapshot());
  }

  function touch(providerId) {
    broadcastAll();
    if (onStateChange) onStateChange(providerId, states[providerId] || null);
  }

  function ensureState(provider) {
    if (!states[provider.id]) {
      states[provider.id] = {
        id: provider.id,
        authStatus: null,
        quota: null,
        balance: null,
        usage: null,
        lastError: null,
        lastFetchedAt: null
      };
    }
    return states[provider.id];
  }

  function setAuth(providerId, status) {
    const st = states[providerId];
    if (st && st.authStatus !== status) {
      st.authStatus = status;
      st.authStatusChangedAt = Date.now();
      touch(providerId);
    }
  }

  async function runOnce(providerId, channel, fn) {
    const key = providerId + ':' + channel;
    if (inflight.has(key)) return;
    inflight.add(key);
    try {
      await fn();
    } finally {
      inflight.delete(key);
    }
  }

  async function pollBalance(provider) {
    const st = ensureState(provider);
    try {
      const balance = await provider.fetchBalance(ctxFor(provider));
      st.balance = balance;
      st.lastError = null;
      st.lastFetchedAt = Date.now();
      if (st.authStatus === 'expired') setAuth(provider.id, 'ok');
      touch(provider.id);
    } catch (e) {
      st.lastError = e && e.message ? e.message : String(e);
      if (isAuthError(e)) setAuth(provider.id, 'expired');
    }
  }

  async function pollUsage(provider) {
    const st = ensureState(provider);
    const now = new Date();
    try {
      const usage = await provider.fetchUsage(ctxFor(provider), {
        month: now.getMonth() + 1,
        year: now.getFullYear()
      });
      st.usage = usage;
      st.lastError = null;
      st.lastFetchedAt = Date.now();
      if (st.authStatus === 'expired') setAuth(provider.id, 'ok');
      touch(provider.id);
    } catch (e) {
      st.lastError = e && e.message ? e.message : String(e);
      if (isAuthError(e)) setAuth(provider.id, 'expired');
    }
  }

  async function pollQuota(provider) {
    const st = ensureState(provider);
    try {
      const quota = await provider.fetchQuota(ctxFor(provider));
      st.quota = quota;
      st.lastError = null;
      st.lastFetchedAt = Date.now();
      if (st.authStatus === 'expired') setAuth(provider.id, 'ok');
      touch(provider.id);
    } catch (e) {
      st.lastError = e && e.message ? e.message : String(e);
      if (isAuthError(e)) setAuth(provider.id, 'expired');
    }
  }

  async function pollLocalLog(provider) {
    try {
      // readLocalLog 自行增量合并进 store 键 'usageDaily',无需 broadcast(热力图按需读取)。
      await provider.readLocalLog(ctxFor(provider));
    } catch (e) {
      // localLog 失败不改变 authStatus,仅记录
      const st = states[provider.id];
      if (st) st.lastError = e && e.message ? e.message : String(e);
    }
  }

  function schedule(provider, channel, fn, intervalMs) {
    if (!enabled) return;
    runOnce(provider.id, channel, fn);
    timers.push(setInterval(() => runOnce(provider.id, channel, fn), intervalMs));
  }

  function start() {
    registry.list().forEach((provider) => {
      ensureState(provider);
      const ctx = ctxFor(provider);
      states[provider.id].authStatus = typeof provider.authStatus === 'function'
        ? provider.authStatus(ctx)
        : 'ok';
      if (provider.capabilities.balance && typeof provider.fetchBalance === 'function') {
        schedule(provider, 'balance', () => pollBalance(provider), enabled.balance);
      }
      if (provider.capabilities.webUsage && typeof provider.fetchUsage === 'function') {
        schedule(provider, 'usage', () => pollUsage(provider), enabled.usage);
      }
      if (provider.capabilities.quota && typeof provider.fetchQuota === 'function') {
        schedule(provider, 'quota', () => pollQuota(provider), enabled.quota);
      }
      if (provider.capabilities.localLog && typeof provider.readLocalLog === 'function') {
        schedule(provider, 'localLog', () => pollLocalLog(provider), enabled.localLog);
      }
    });
    touch('__all__');
  }

  // 手动触发(测试/立即刷新)。
  async function poll(providerId, channel) {
    const provider = registry.get(providerId);
    if (!provider) return;
    if (channel === 'balance' && typeof provider.fetchBalance === 'function') {
      await runOnce(providerId, channel, () => pollBalance(provider));
    } else if (channel === 'usage' && typeof provider.fetchUsage === 'function') {
      await runOnce(providerId, channel, () => pollUsage(provider));
    } else if (channel === 'quota' && typeof provider.fetchQuota === 'function') {
      await runOnce(providerId, channel, () => pollQuota(provider));
    }
  }

  async function pollAll() {
    for (const provider of registry.list()) {
      if (provider.capabilities.balance && typeof provider.fetchBalance === 'function') {
        await runOnce(provider.id, 'balance', () => pollBalance(provider));
      }
      if (provider.capabilities.webUsage && typeof provider.fetchUsage === 'function') {
        await runOnce(provider.id, 'usage', () => pollUsage(provider));
      }
      if (provider.capabilities.quota && typeof provider.fetchQuota === 'function') {
        await runOnce(provider.id, 'quota', () => pollQuota(provider));
      }
      // 手动刷新也补一遍本地日志合并,热力图/全平台柱状图(usageDaily)立即拿到最新数据
      if (provider.capabilities.localLog && typeof provider.readLocalLog === 'function') {
        await runOnce(provider.id, 'localLog', () => pollLocalLog(provider));
      }
    }
  }

  function getState(providerId) {
    return states[providerId] || null;
  }

  function getSnapshot() {
    return registry.list().map((provider) => {
      const st = states[provider.id] || {};
      return {
        id: provider.id,
        displayName: provider.displayName,
        capabilities: provider.capabilities,
        authStatus: st.authStatus || 'ok',
        quota: st.quota || null,
        lastError: st.lastError || null
      };
    });
  }

  function stop() {
    timers.forEach((t) => clearInterval(t));
    timers.length = 0;
  }

  start();

  return { stop, getState, getSnapshot, poll, pollAll };
}

module.exports = { startScheduler, DEFAULT_INTERVALS, isAuthError };
