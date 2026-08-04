const { app, dialog, shell } = require('electron');
const storeModule = require('./store');
const { runStoreBootstrap } = require('./core/startup-recovery');

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.isQuitting = true;
  app.quit();
} else {
  app.whenReady()
    .then(() => runStoreBootstrap({
      app,
      dialog,
      shell,
      storeModule,
      loadMain: () => require('./index'),
      logger: console
    }))
    .catch(() => {
      console.error('[bootstrap]', JSON.stringify({ code: 'BOOTSTRAP_FAILED' }));
      app.isQuitting = true;
      app.quit();
    });
}
