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

export function getTokenSpeed() {
  return api.invoke('get:token-speed');
}

export function getEdgeDockState() {
  return api.invoke('get:edge-dock-state');
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

export function onTokenSpeedChanged(cb) {
  return api.on('token-speed:changed', cb);
}

export function saveSetting(key, value) {
  return api.invoke('settings:save', { key, value });
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

export function toggleMini() {
  return api.send('window:toggle-mini');
}

export default api;
