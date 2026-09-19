import { useCallback, useSyncExternalStore } from 'react';
import * as api from './api.js';
import { createProviderData } from './provider-data.js';

const data = createProviderData(api);

export const initProviders = data.init;
export const refreshProviders = data.refreshProviders;

export function useProviders() {
  return useSyncExternalStore(data.subscribe, data.getSnapshot, data.getSnapshot);
}

function useQuery(cache, key) {
  const subscribe = useCallback((listener) => cache.subscribe(key, listener), [cache, key]);
  const snapshot = () => cache.read(key);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useDashboard(providerId) {
  return useQuery(data.dashboards, providerId);
}

export function useHeatmap({ provider = 'all', year }) {
  return useQuery(data.heatmaps, JSON.stringify([provider, year]));
}
