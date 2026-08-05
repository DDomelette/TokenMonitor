const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  on: (channel, callback) => {
    const validChannels = [
      'settings:loaded',
      'login:error',
      'open:settings',
      'theme:changed',
      'window:bounds-changed',
      'session:changed',
      'providers:changed'
    ];
    if (validChannels.includes(channel)) {
      const listener = (event, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
    return () => {};
  },

  send: (channel, data) => {
    const validChannels = [
      'settings:update',
      'settings:reset',
      'login:submit',
      'window:minimize',
      'window:close',
      'window:close-settings',
      'refresh:dashboard',
      'open:settings',
      'zoom:change',
      'session:relogin',
      'window:set-bounds',
      'resize:start',
      'resize:move',
      'resize:end'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },

  invoke: (channel, ...args) => {
    const validChannels = [
      'get:settings',
      'settings:save',
      'settings:replace-api-key',
      'get:dashboard',
      'get:providers',
      'get:heatmap',
      'get:bounds',
      'get:session-state',
      'window:commit'
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error('Invalid channel: ' + channel));
  }
});
