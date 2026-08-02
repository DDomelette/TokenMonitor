// React hooks:订阅 providers / dashboard 快照(基于 useSyncExternalStore)。
import { useProviders, useDashboard, initProviders } from '../store.js';

export default function useProvidersHook() {
  return useProviders();
}

export { useProviders, useDashboard, initProviders };
