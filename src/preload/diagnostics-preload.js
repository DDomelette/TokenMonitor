const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('diagnosticsApi', Object.freeze({
  run: () => ipcRenderer.invoke('diagnostics:run'),
  copyReport: (runId) => ipcRenderer.invoke('diagnostics:copy-report', runId),
  openGuide: (guideId) => ipcRenderer.invoke('diagnostics:open-guide', guideId),
  getTheme: () => ipcRenderer.invoke('diagnostics:get-theme'),
  close: () => ipcRenderer.send('window:close-diagnostics'),
  onProgress: (callback) => subscribe('diagnostics:progress', callback),
  onThemeChanged: (callback) => subscribe('theme:changed', callback),
  onFocusState: (callback) => subscribe('window:focus-state', callback)
}));
