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

function registerDiagnosticsIpc({
  ipcMain,
  diagnostics,
  getDiagnosticsWindow,
  createDiagnosticsWindow,
  getDiagnosticsTheme
}) {
  if (!ipcMain || typeof ipcMain.on !== 'function' || typeof ipcMain.handle !== 'function' ||
      typeof ipcMain.removeListener !== 'function' || typeof ipcMain.removeHandler !== 'function') {
    throw new TypeError('ipcMain is required');
  }
  if (registered.has(ipcMain)) return false;

  const openDiagnostics = () => {
    try {
      createDiagnosticsWindow();
      return { ok: true };
    } catch (_) {
      return failure('DIAGNOSTICS_OPEN_FAILED');
    }
  };

  const closeDiagnostics = (event) => {
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
  };

  const runDiagnostics = async (event) => {
    const sender = activeSender(event, getDiagnosticsWindow);
    if (!sender) return failure('DIAGNOSTICS_SENDER_INVALID');
    try {
      return await diagnostics.start(sender);
    } catch (_) {
      return failure('DIAGNOSTICS_RUN_FAILED');
    }
  };

  const copyDiagnostics = async (event, runId) => {
    const sender = activeSender(event, getDiagnosticsWindow);
    if (!sender) return failure('DIAGNOSTICS_SENDER_INVALID');
    try {
      return await diagnostics.copy(sender, runId);
    } catch (_) {
      return failure('DIAGNOSTICS_COPY_FAILED');
    }
  };

  const openDiagnosticsGuide = async (event, guideId) => {
    const sender = activeSender(event, getDiagnosticsWindow);
    if (!sender) return failure('DIAGNOSTICS_SENDER_INVALID');
    try {
      return await diagnostics.openGuide(sender, guideId);
    } catch (_) {
      return failure('DIAGNOSTICS_GUIDE_FAILED');
    }
  };

  const readDiagnosticsTheme = async (event) => {
    const sender = activeSender(event, getDiagnosticsWindow);
    if (!sender) return failure('DIAGNOSTICS_SENDER_INVALID');
    try {
      if (typeof getDiagnosticsTheme !== 'function') throw new Error('Diagnostics theme unavailable');
      return await getDiagnosticsTheme();
    } catch (_) {
      return failure('DIAGNOSTICS_THEME_FAILED');
    }
  };

  const registrations = [
    { type: 'on', channel: 'open:diagnostics', callback: openDiagnostics },
    { type: 'on', channel: 'window:close-diagnostics', callback: closeDiagnostics },
    { type: 'handle', channel: 'diagnostics:run', callback: runDiagnostics },
    { type: 'handle', channel: 'diagnostics:copy-report', callback: copyDiagnostics },
    { type: 'handle', channel: 'diagnostics:open-guide', callback: openDiagnosticsGuide },
    { type: 'handle', channel: 'diagnostics:get-theme', callback: readDiagnosticsTheme }
  ];
  const completed = [];
  try {
    for (const registration of registrations) {
      ipcMain[registration.type](registration.channel, registration.callback);
      completed.push(registration);
    }
  } catch (error) {
    for (let index = completed.length - 1; index >= 0; index -= 1) {
      const registration = completed[index];
      try {
        if (registration.type === 'handle' && typeof ipcMain.removeHandler === 'function') {
          ipcMain.removeHandler(registration.channel);
        } else if (registration.type === 'on' && typeof ipcMain.removeListener === 'function') {
          ipcMain.removeListener(registration.channel, registration.callback);
        }
      } catch (_) {
        // Registration rollback is best-effort; the original failure remains authoritative.
      }
    }
    throw error;
  }

  registered.add(ipcMain);

  return true;
}

module.exports = { registerDiagnosticsIpc };
