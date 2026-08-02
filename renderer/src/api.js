// window.api 的 React 侧封装(IPC 白名单见 src/preload/preload.js)。
const api = window.api;

export function getProviders() {
  return api.invoke('get:providers');
}

export function getDashboard(providerId) {
  return api.invoke('get:dashboard', providerId);
}

export function getHeatmap(arg) {
  return api.invoke('get:heatmap', arg);
}

export function getBounds() {
  return api.invoke('get:bounds');
}

export function getSettings() {
  return api.invoke('get:settings');
}

export function onProvidersChanged(cb) {
  return api.on('providers:changed', cb);
}

export function onBoundsChanged(cb) {
  return api.on('window:bounds-changed', cb);
}

export function on(channel, cb) {
  return api.on(channel, cb);
}

export function send(channel, data) {
  return api.send(channel, data);
}

export default api;
