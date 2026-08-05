const { app, dialog, shell } = require('electron');
const storeModule = require('./store');
const { runStoreBootstrap } = require('./core/startup-recovery');
const { installRoundedMainWindowShapeObserver } = require('./core/window-shape');
const { pruneUsageDaily } = require('./core/usage-retention');
const { assertRendererBuild } = require('./core/renderer-entry');

installRoundedMainWindowShapeObserver(app);

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.isQuitting = true;
  app.quit();
} else {
  app.whenReady()
    .then(() => {
      assertRendererBuild();
      return runStoreBootstrap({
        app,
        dialog,
        shell,
        storeModule,
        afterInitialize: () => pruneUsageDaily(storeModule),
        loadMain: () => require('./index'),
        logger: console
      });
    })
    .catch((error) => {
      const code = error && error.code === 'RENDERER_BUILD_MISSING'
        ? 'RENDERER_BUILD_MISSING'
        : 'BOOTSTRAP_FAILED';
      console.error('[bootstrap]', JSON.stringify({ code }));
      app.isQuitting = true;
      app.quit();
    });
}
