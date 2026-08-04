const {
  buildStoreRecoveryDialog,
  safeStoreStartupMetadata
} = require('./store-recovery-safe');

function safeLog(logger, label, fields) {
  if (!logger || typeof logger.error !== 'function') return;
  logger.error(label, JSON.stringify(fields));
}

async function runStoreBootstrap({
  app,
  dialog,
  shell,
  storeModule,
  loadMain,
  logger = console
}) {
  let startupError;
  try {
    const userDataDir = app.getPath('userData');
    storeModule.initialize({ userDataDir });
  } catch (error) {
    startupError = error;
  }

  if (!startupError) {
    loadMain();
    return { started: true };
  }

  const metadata = safeStoreStartupMetadata(startupError);
  const recovery = buildStoreRecoveryDialog(startupError);
  safeLog(logger, '[store:startup]', metadata);

  let response = recovery.options.cancelId;
  try {
    const result = await dialog.showMessageBox(recovery.options);
    if (result && Number.isInteger(result.response)) response = result.response;
  } catch {
    safeLog(logger, '[store:dialog]', { code: 'DIALOG_FAILED' });
  }

  if (recovery.backupDir && response === recovery.openBackupButton) {
    try {
      const openError = await shell.openPath(recovery.backupDir);
      if (openError) {
        safeLog(logger, '[store:open-backup]', { code: 'OPEN_BACKUP_FAILED' });
      }
    } catch {
      safeLog(logger, '[store:open-backup]', { code: 'OPEN_BACKUP_FAILED' });
    }
  }

  app.isQuitting = true;
  app.quit();
  return { started: false, code: metadata.code };
}

module.exports = { runStoreBootstrap };
