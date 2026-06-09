const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  on: (channel, callback) => {
    const validChannels = [
      'data:update',
      'balance:update',
      'curve:token',
      'curve:cost',
      'proxy:status',
      'settings:loaded'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },

  send: (channel, data) => {
    const validChannels = [
      'settings:update',
      'settings:reset',
      'proxy:restart',
      'proxy:toggle',
      'login:submit',
      'window:minimize',
      'window:close',
      'get:settings'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },

  invoke: (channel, ...args) => {
    const validChannels = ['get:settings'];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error(`Invalid channel: ${channel}`));
  }
});
