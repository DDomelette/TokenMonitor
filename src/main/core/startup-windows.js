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

function skipDeepseekLogin(options) {
  const loginWindow = options.getLoginWindow();
  if (isUsableWindow(loginWindow) && typeof loginWindow.close === 'function') {
    loginWindow.close();
  }

  const mainWindow = ensureMainWindow(options);
  if (typeof mainWindow.show === 'function') mainWindow.show();
  if (typeof mainWindow.focus === 'function') mainWindow.focus();
  return mainWindow;
}

module.exports = {
  MAIN_WINDOW_UNAVAILABLE,
  ensureMainWindow,
  isUsableWindow,
  skipDeepseekLogin
};
