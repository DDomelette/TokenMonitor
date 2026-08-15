const { app, dialog, shell } = require('electron');
const storeModule = require('./store');
const { runStoreBootstrap } = require('./core/startup-recovery');
const { pruneUsageDaily, pruneDshPushUsage } = require('./core/usage-retention');
const { assertRendererBuild } = require('./core/renderer-entry');

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
        afterInitialize: () => {
          pruneUsageDaily(storeModule);
          pruneDshPushUsage(storeModule);
        },
        loadMain: () => require('./index'),
        logger: console
      });
    })
    .catch((error) => {
      const details = error && error.code === 'RENDERER_BUILD_MISSING'
        ? { code: 'RENDERER_BUILD_MISSING', action: 'npm run build:renderer' }
        : { code: 'BOOTSTRAP_FAILED' };
      console.error('[bootstrap]', JSON.stringify(details));
      app.isQuitting = true;
      app.quit();
    });
}
