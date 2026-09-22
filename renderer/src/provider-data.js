import { createQueryCache } from './lib/query-cache.js';

// 数据订阅独立于 React,让主窗/小窗以及两个热力图消费者共享取数。
export function createProviderData(api) {
  let providers = [];
  let initialized = false;
  let revision = 0;
  const listeners = new Set();
  const dashboards = createQueryCache((providerId) => api.getDashboard(providerId));
  const heatmaps = createQueryCache((key) => {
    const [provider, year] = JSON.parse(key);
    return api.getHeatmap({ provider, year });
  });

  function setProviders(snapshot) {
    providers = Array.isArray(snapshot) ? snapshot : [];
    listeners.forEach((listener) => listener());
  }

  function invalidate(change) {
    // 兼容没有变化明细的旧广播(例如运行时迁移完成)。
    if (!change || change.channel === 'all') {
      dashboards.invalidate();
      heatmaps.invalidate();
      return;
    }
    const { providerId, channel } = change;
    if (['balance', 'usage', 'localLog'].includes(channel)) {
      dashboards.invalidate((key) => key === providerId);
    }
    if (channel === 'usage' || channel === 'localLog') {
      heatmaps.invalidate((key) => {
        const [provider] = JSON.parse(key);
        // all 的明细与合计都不包含 Harness。
        return provider === providerId || (provider === 'all' && providerId !== 'dsh');
      });
    }
  }

  function refreshProviders() {
    const requestedAt = revision;
    return api.getProviders().then((snapshot) => {
      if (revision === requestedAt) setProviders(snapshot);
    }).catch(() => {});
  }

  return {
    dashboards,
    heatmaps,
    refreshProviders,
    getSnapshot: () => providers,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    init() {
      if (initialized) return;
      initialized = true;
      api.onProvidersChanged((snapshot, change) => {
        revision += 1;
        invalidate(change);
        setProviders(snapshot);
      });
      refreshProviders();
    }
  };
}
