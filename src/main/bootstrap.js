const { app, dialog, shell } = require('electron');
const storeModule = require('./store');
const { runStoreBootstrap } = require('./core/startup-recovery');

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
