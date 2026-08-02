// useSyncExternalStore 的极简 store:providers 快照 + dashboardById 缓存。
// 订阅源是 preload 的 'providers:changed' 广播(任何 provider 数据/状态更新时全量推送)。
import { useSyncExternalStore } from 'react';
import { getProviders, getDashboard as apiGetDashboard, onProvidersChanged } from './api.js';

let providers = [];
let providersLoaded = false;
const dashboardCache = {};
const listeners = new Set();

function emit() {
  listeners.forEach((cb) => cb());
}

function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return providers;
}

export function initProviders() {
  if (providersLoaded) return;
  providersLoaded = true;
  refreshProviders();
  onProvidersChanged((snapshot) => {
    providers = Array.isArray(snapshot) ? snapshot : [];
    // 任何 provider 更新都可能伴随 dashboard 数据变化:重取已缓存的 dashboard,避免停在首帧空数据
    Object.keys(dashboardCache).forEach((pid) => {
      apiGetDashboard(pid).then((payload) => {
        dashboardCache[pid] = payload;
        emit();
      }).catch(() => {});
    });
    emit();
  });
}

export function refreshProviders() {
  getProviders().then((snapshot) => {
    providers = Array.isArray(snapshot) ? snapshot : [];
    emit();
  }).catch(() => {});
}

export function getDashboard(providerId) {
  if (dashboardCache[providerId]) return dashboardCache[providerId];
  apiGetDashboard(providerId).then((payload) => {
    dashboardCache[providerId] = payload;
    emit();
  }).catch(() => {});
  return null;
}

export function useProviders() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useDashboard(providerId) {
  const snapshot = useSyncExternalStore(subscribe, () => dashboardCache[providerId] || null, () => dashboardCache[providerId] || null);
  getDashboard(providerId);
  return snapshot;
}

export { dashboardCache };
