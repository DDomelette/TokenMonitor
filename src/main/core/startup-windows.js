const MAIN_WINDOW_UNAVAILABLE = 'MAIN_WINDOW_UNAVAILABLE';

function isUsableWindow(win) {
  if (!win) return false;
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false;
  return true;
}

function ensureMainWindow(options) {
  let mainWindow = options.getMainWindow();
  if (!isUsableWindow(mainWindow)) {
    options.createMainWindow();
    mainWindow = options.getMainWindow();
  }

  if (!isUsableWindow(mainWindow)) {
    const error = new Error('Main window was not created');
    error.code = MAIN_WINDOW_UNAVAILABLE;
    throw error;
  }

  return mainWindow;
}

function wakeWindow(win) {
  if (!isUsableWindow(win)) return null;

  if (
    typeof win.isMinimized === 'function'
    && win.isMinimized()
    && typeof win.restore === 'function'
  ) {
    win.restore();
  }
  if (typeof win.show === 'function') win.show();
  if (typeof win.focus === 'function') win.focus();
  return win;
}

function wakeMostRelevantWindow(options) {
  const getters = [
    options.getMainWindow,
    options.getLoginWindow,
    options.getSettingsWindow
  ];

  for (const getWindow of getters) {
    if (typeof getWindow !== 'function') continue;
    const win = getWindow();
    if (isUsableWindow(win)) return wakeWindow(win);
  }
  return null;
}

function skipDeepseekLogin(options) {
  const mainWindow = ensureMainWindow(options);
  if (typeof mainWindow.show === 'function') mainWindow.show();
  if (typeof mainWindow.focus === 'function') mainWindow.focus();

  const loginWindow = options.getLoginWindow();
  if (isUsableWindow(loginWindow) && typeof loginWindow.close === 'function') {
    loginWindow.close();
  }

  return mainWindow;
}

module.exports = {
  MAIN_WINDOW_UNAVAILABLE,
  ensureMainWindow,
  isUsableWindow,
  skipDeepseekLogin,
  wakeMostRelevantWindow,
  wakeWindow
};
