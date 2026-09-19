// 多 Provider 调度器:每 provider 按 capability 独立定时器轮询 usage/quota/balance。
// 所有可见轮询状态转换都会广播;相同 channel 的重复错误保持静默。
const { httpGet } = require('./http');
const { summarizeProviderError } = require('./provider-error-summary');
const {
  SYSTEM_PROXY_VALUE,
  resolveElectronSystemProxy
} = require('./proxy-settings');

const DEFAULT_INTERVALS = { usage: 10 * 1000, quota: 60 * 1000, balance: 60 * 1000, localLog: 60 * 1000 };

function isAuthError(err) {
  const msg = (err && (err.message || String(err))) || '';
  return /unauthoriz|401|403|登录|expired|invalid token/i.test(msg);
}

function startScheduler({
  registry,
  store,
  broadcast,
  intervals,
  onStateChange,
  getProxyInput,
  onUsageObservation,
  onUsageUnavailable,
  codexUsageRuntime
}) {
  const enabled = intervals === false ? false : Object.assign({}, DEFAULT_INTERVALS, intervals || {});
  const timers = [];
  const states = Object.create(null);
  const inflight = new Map();

  function getProxyUrl() {
    if (typeof getProxyInput === 'function') return getProxyInput();
    const stored = store.get('providers.proxyUrl') || null;
    return stored === SYSTEM_PROXY_VALUE ? resolveElectronSystemProxy : stored;
  }

  function ctxFor(provider) {
    return {
      store: store,
      httpGet: httpGet,
      getProxyUrl: getProxyUrl,
      logger: console
    };
  }

  function touch(providerId, channel = 'status') {
    broadcast('providers:changed', getSnapshot(), { providerId, channel });
    if (onStateChange) onStateChange(providerId, states[providerId] || null);
  }

  function ensureState(provider) {
    if (!states[provider.id]) {
      states[provider.id] = {
        id: provider.id,
        authStatus: null,
        quota: null,
        quotaFetchedAt: null,
        balance: null,
        usage: null,
        channelErrors: Object.create(null),
        failureSequence: 0,
        lastError: null,
        lastErrorChannel: null,
        lastFailedAt: null,
        lastFetchedAt: null,
        stale: false
      };
      // 冷启动回填上次成功的额度:凭证过期/网络失败时卡片仍可显示旧数据,
      // 由下一轮轮询的结果决定更新还是保持。
      const persisted = store.get('providers.' + provider.id + '.lastQuota');
      if (persisted && persisted.quota) {
        states[provider.id].quota = persisted.quota;
        states[provider.id].quotaFetchedAt = persisted.fetchedAt || null;
      }
    }
    return states[provider.id];
  }

  function refreshFailureSummary(st) {
    let latest = null;
    Object.keys(st.channelErrors).forEach((channel) => {
      const candidate = st.channelErrors[channel];
      if (!latest || candidate.sequence > latest.sequence) {
        latest = Object.assign({ channel }, candidate);
      }
    });

    st.lastError = latest ? latest.message : null;
    st.lastErrorChannel = latest ? latest.channel : null;
    st.lastFailedAt = latest ? latest.failedAt : null;
    st.stale = !!latest && Number.isFinite(st.lastFetchedAt);
  }

  function failureSignature(st) {
    return JSON.stringify([
      st.authStatus,
      st.lastError,
      st.lastErrorChannel,
      st.lastFailedAt,
      st.stale
    ]);
  }

  function setAuthStatus(provider, status) {
    const st = ensureState(provider);
    if (!status || st.authStatus === status) return false;
    st.authStatus = status;
    st.authStatusChangedAt = Date.now();
    touch(provider.id);
    return true;
  }

  function readAuthStatus(provider) {
    if (typeof provider.authStatus !== 'function') return 'ok';
    return provider.authStatus(ctxFor(provider)) || 'ok';
  }

  function canPollProtected(provider) {
    const observed = readAuthStatus(provider);
    if (observed !== 'missing') return true;
    setAuthStatus(provider, 'missing');
    return false;
  }

  function notifyUsageObservation(provider, channel) {
    if (typeof onUsageObservation !== 'function') return;
    try {
      onUsageObservation(provider.id, { channel, observedAt: Date.now() });
    } catch (_) {}
  }

  function notifyUsageUnavailable(provider, channel) {
    if (typeof onUsageUnavailable !== 'function') return;
    try {
      onUsageUnavailable(provider.id, { channel, observedAt: Date.now() });
    } catch (_) {}
  }

  function recordFailure(provider, channel, error) {
    const st = ensureState(provider);
    const before = failureSignature(st);
    const message = summarizeProviderError(error);
    const auth = isAuthError(error);
    const previous = st.channelErrors[channel];

    if (!previous || previous.message !== message || previous.auth !== auth) {
      st.failureSequence += 1;
      st.channelErrors[channel] = {
        auth,
        failedAt: Date.now(),
        message,
        sequence: st.failureSequence
      };
    }

    if (auth && st.authStatus !== 'expired') {
      st.authStatus = 'expired';
      st.authStatusChangedAt = Date.now();
    }

    refreshFailureSummary(st);
    if (failureSignature(st) !== before) touch(provider.id);
  }

  function recordSuccess(provider, channel, value, fetchedAt = Date.now()) {
    const st = ensureState(provider);
    st[channel] = value;
    st.lastFetchedAt = fetchedAt;
    delete st.channelErrors[channel];

    if (st.authStatus !== 'ok') {
      st.authStatus = 'ok';
      st.authStatusChangedAt = Date.now();
    }

    refreshFailureSummary(st);
    touch(provider.id, channel);
  }

  function recordChannelRecovery(provider, channel, notify = true) {
    const st = ensureState(provider);
    if (!st.channelErrors[channel]) return false;

    delete st.channelErrors[channel];
    refreshFailureSummary(st);
    if (notify) touch(provider.id);
    return true;
  }

  function runExclusive(providerId, channel, fn) {
    const key = providerId + ':' + channel;
    const prior = inflight.get(key);
    let task;
    if (prior) {
      task = Promise.resolve(prior).catch(() => {}).then(fn);
    } else {
      try {
        task = Promise.resolve(fn());
      } catch (error) {
        task = Promise.reject(error);
      }
    }
    inflight.set(key, task);
    const cleanup = () => {
      if (inflight.get(key) === task) inflight.delete(key);
    };
    task.then(cleanup, cleanup);
    return task;
  }

  function runOnce(providerId, channel, fn) {
    const key = providerId + ':' + channel;
    return inflight.get(key) || runExclusive(providerId, channel, fn);
  }

  async function pollBalance(provider) {
    if (!canPollProtected(provider)) return;
    try {
      const balance = await provider.fetchBalance(ctxFor(provider));
      recordSuccess(provider, 'balance', balance);
    } catch (error) {
      recordFailure(provider, 'balance', error);
    }
  }

  async function pollUsage(provider) {
    if (!canPollProtected(provider)) {
      notifyUsageUnavailable(provider, 'usage');
      return;
    }
    const now = new Date();
    try {
      const usage = await provider.fetchUsage(ctxFor(provider), {
        month: now.getMonth() + 1,
        year: now.getFullYear()
      });
      recordSuccess(provider, 'usage', usage);
      notifyUsageObservation(provider, 'usage');
    } catch (error) {
      recordFailure(provider, 'usage', error);
      notifyUsageUnavailable(provider, 'usage');
    }
  }

  async function pollQuota(provider) {
    if (!canPollProtected(provider)) return;
    try {
      const quota = await provider.fetchQuota(ctxFor(provider));
      const fetchedAt = Date.now();
      ensureState(provider).quotaFetchedAt = quota ? fetchedAt : null;
      // 每次成功都持久化一份:下次失败(过期/断网)乃至重启后都能保持显示
      if (quota) {
        try {
          store.set('providers.' + provider.id + '.lastQuota', { quota: quota, fetchedAt: fetchedAt });
        } catch (_) { /* 持久化失败(磁盘/只读 store)不影响本轮结果 */ }
      }
      recordSuccess(provider, 'quota', quota, fetchedAt);
    } catch (error) {
      recordFailure(provider, 'quota', error);
    }
  }

  async function pollLocalLog(provider) {
    try {
      const ctx = ctxFor(provider);
      if (provider.id === 'dsh' && typeof provider.shouldPollLocalLog === 'function'
          && !provider.shouldPollLocalLog(ctx)) {
        // push 模式/活跃 source:跳过本轮文件扫描,不产生错误状态。
        return;
      }
      // Provider 先把增量合并进 usageDaily,随后按真实新增记录决定是否刷新界面。
      // Codex 经由运行时 FIFO 协调器串行化所有写操作;其它 provider 直接读取。
      // dsh 的 readLocalLog 接受 opts.diagnostics(行解析/截断尾行等计数);
      // 其余 provider 保持原调用形态不变。
      const diagnostics = {};
      const batch = (provider.id === 'codex' && codexUsageRuntime)
        ? await codexUsageRuntime.runIncremental((scanOptions) =>
          provider.readLocalLog(ctx, scanOptions)
        )
        : (provider.id === 'dsh'
            ? await provider.readLocalLog(ctx, { diagnostics })
            : await provider.readLocalLog(ctx));
      const records = Array.isArray(batch) ? batch : batch.records;
      const changed = Array.isArray(records) && records.length > 0;
      const recovered = recordChannelRecovery(provider, 'localLog', false);
      if (changed || recovered) touch(provider.id, changed ? 'localLog' : 'status');
      notifyUsageObservation(provider, 'localLog');
      // 非零解析诊断打一行日志,便于观测遥测数据完整性(坏行/截断尾行/版本不符等)。
      const diagnosticKeys = Object.keys(diagnostics).filter((key) => diagnostics[key] > 0);
      if (diagnosticKeys.length) {
        console.warn('[scheduler] localLog diagnostics for ' + provider.id + ': '
          + diagnosticKeys.map((key) => key + '=' + diagnostics[key]).join(', '));
      }
    } catch (error) {
      recordFailure(provider, 'localLog', error);
      notifyUsageUnavailable(provider, 'localLog');
    }
  }

  function schedule(provider, channel, fn, intervalMs) {
    if (!enabled) return;
    runOnce(provider.id, channel, fn);
    timers.push(setInterval(() => runOnce(provider.id, channel, fn), intervalMs));
  }

  const channels = {
    balance: { capability: 'balance', method: 'fetchBalance', poll: pollBalance },
    usage: { capability: 'webUsage', method: 'fetchUsage', poll: pollUsage },
    quota: { capability: 'quota', method: 'fetchQuota', poll: pollQuota },
    localLog: { capability: 'localLog', method: 'readLocalLog', poll: pollLocalLog }
  };

  function supportedChannels(provider) {
    return Object.keys(channels).filter((channel) => {
      const spec = channels[channel];
      return provider.capabilities[spec.capability] && typeof provider[spec.method] === 'function';
    });
  }

  function start() {
    registry.list().forEach((provider) => {
      const st = ensureState(provider);
      st.authStatus = readAuthStatus(provider);
      supportedChannels(provider).forEach((channel) => {
        schedule(provider, channel, () => channels[channel].poll(provider), enabled[channel]);
      });
    });
    touch('__all__', 'all');
  }

  // 手动触发(测试/立即刷新)。
  async function poll(providerId, channel) {
    const provider = registry.get(providerId);
    const spec = Object.hasOwn(channels, channel) ? channels[channel] : null;
    if (!provider || !spec || typeof provider[spec.method] !== 'function') return;
    await runOnce(providerId, channel, () => spec.poll(provider));
  }

  async function pollAll() {
    const network = [];
    const localLogs = [];
    for (const provider of registry.list()) {
      supportedChannels(provider).forEach((channel) => {
        (channel === 'localLog' ? localLogs : network).push(() => poll(provider.id, channel));
      });
    }
    // 网络最多两路并发;本地扫描保持顺序,无需等待网络超时才刷新本机用量。
    const drain = async (queue) => {
      while (queue.length) await queue.shift()();
    };
    await Promise.all([drain(network), drain(network), drain(localLogs)]);
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
        quotaFetchedAt: st.quotaFetchedAt || null,
        lastError: st.lastError || null,
        lastErrorChannel: st.lastErrorChannel || null,
        lastFailedAt: st.lastFailedAt || null,
        lastFetchedAt: st.lastFetchedAt || null,
        stale: !!st.stale
      };
    });
  }

  function stop() {
    timers.forEach((timer) => clearInterval(timer));
    timers.length = 0;
  }

  start();

  return { stop, getState, getSnapshot, poll, pollAll, runExclusive };
}

module.exports = { startScheduler, DEFAULT_INTERVALS, isAuthError };
