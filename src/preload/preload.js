const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  on: (channel, callback) => {
    const validChannels = [
      'data:update',
      'balance:update',
      'curve:token',
      'curve:cost',
      'proxy:status',
      'settings:loaded',
      'login:error',
      'open:settings',
      'theme:changed'
    ];
    if (validChannels.includes(channel)) {
      const listener = (event, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
    }
  },

  send: (channel, data) => {
    const validChannels = [
      'settings:update',
      'settings:reset',
      'login:submit',
      'window:minimize',
      'window:close'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },

  invoke: (channel, ...args) => {
    const validChannels = ['get:settings', 'get:dashboard'];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error('Invalid channel: ' + channel));
  }
});
