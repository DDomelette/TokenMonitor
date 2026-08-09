const registered = new WeakSet();

function failure(errorCode) {
  return { ok: false, errorCode };
}

function activeSender(event, getDiagnosticsWindow) {
  let window;
  try {
    window = getDiagnosticsWindow();
    if (!window || window.isDestroyed()) return null;
    const contents = window.webContents;
    if (!contents || contents.isDestroyed()) return null;
    const sender = event && event.sender;
    if (sender !== contents || sender.id !== contents.id || sender.isDestroyed()) return null;
    return sender;
  } catch (_) {
    return null;
  }
}

function registerDiagnosticsIpc({ ipcMain, diagnostics, getDiagnosticsWindow, createDiagnosticsWindow }) {
  if (!ipcMain || typeof ipcMain.on !== 'function' || typeof ipcMain.handle !== 'function') {
    throw new TypeError('ipcMain is required');
  }
  if (registered.has(ipcMain)) return false;
  registered.add(ipcMain);

  ipcMain.on('open:diagnostics', () => {
    try {
      createDiagnosticsWindow();
      return { ok: true };
    } catch (_) {
      return failure('DIAGNOSTICS_OPEN_FAILED');
    }
  });

  ipcMain.on('window:close-diagnostics', (event) => {
    const sender = activeSender(event, getDiagnosticsWindow);
    if (!sender) return failure('DIAGNOSTICS_SENDER_INVALID');
    try {
      const window = getDiagnosticsWindow();
      if (!window || window.isDestroyed() || window.webContents !== sender) {
        return failure('DIAGNOSTICS_SENDER_INVALID');
      }
      window.close();
      return { ok: true };
    } catch (_) {
      return failure('DIAGNOSTICS_CLOSE_FAILED');
    }
  });

  ipcMain.handle('diagnostics:run', async (event) => {
    const sender = activeSender(event, getDiagnosticsWindow);
    if (!sender) return failure('DIAGNOSTICS_SENDER_INVALID');
    try {
      return await diagnostics.start(sender);
    } catch (_) {
      return failure('DIAGNOSTICS_RUN_FAILED');
    }
  });

  ipcMain.handle('diagnostics:copy-report', async (event, runId) => {
    const sender = activeSender(event, getDiagnosticsWindow);
    if (!sender) return failure('DIAGNOSTICS_SENDER_INVALID');
    try {
      return await diagnostics.copy(sender, runId);
    } catch (_) {
      return failure('DIAGNOSTICS_COPY_FAILED');
    }
  });

  ipcMain.handle('diagnostics:open-guide', async (event, guideId) => {
    const sender = activeSender(event, getDiagnosticsWindow);
    if (!sender) return failure('DIAGNOSTICS_SENDER_INVALID');
    try {
      return await diagnostics.openGuide(sender, guideId);
    } catch (_) {
      return failure('DIAGNOSTICS_GUIDE_FAILED');
    }
  });

  return true;
}

module.exports = { registerDiagnosticsIpc };
