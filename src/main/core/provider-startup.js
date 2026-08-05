const NON_DEEPSEEK_STARTUP_STATUSES = new Set(['ok', 'expired']);
const DEEPSEEK_SETUP_MESSAGE = '未配置 DeepSeek API Key，可稍后在设置中添加';

function hasValue(value) {
  return typeof value === 'string' ? value.trim().length > 0 : !!value;
}

function isDestroyed(target) {
  return !!target
    && typeof target.isDestroyed === 'function'
    && target.isDestroyed();
}

function chooseInitialWindow(options = {}) {
  if (hasValue(options.deepseekApiKey)) return 'main';

  const providerSnapshot = Array.isArray(options.providerSnapshot)
    ? options.providerSnapshot
    : [];
  const hasOtherProvider = providerSnapshot.some((provider) => provider
    && provider.id !== 'deepseek'
    && NON_DEEPSEEK_STARTUP_STATUSES.has(provider.authStatus));

  return hasOtherProvider ? 'main' : 'login';
}

function continueWithoutDeepseek(deps) {
  let mainWindow = deps.getMainWindow();
  if (!mainWindow || isDestroyed(mainWindow)) {
    deps.createMainWindow();
    mainWindow = deps.getMainWindow();
  }

  if (mainWindow && !isDestroyed(mainWindow)) mainWindow.show();

  const loginWindow = deps.getLoginWindow();
  if (loginWindow && !isDestroyed(loginWindow)) loginWindow.close();

  return mainWindow || null;
}

function sendSettings(deps) {
  const mainWindow = deps.mainWindow;
  if (!mainWindow || isDestroyed(mainWindow)) return;
  if (!mainWindow.webContents || isDestroyed(mainWindow.webContents)) return;
  mainWindow.webContents.send(
    'settings:loaded',
    deps.sanitizeSettings(deps.store.store)
  );
}

function finishInitialization(deps) {
  deps.broadcastSessionState();
  deps.updateTrayMenu();
}

function initializeMainRenderer(deps) {
  sendSettings(deps);

  const apiKey = deps.store.get('providers.deepseek.apiKey');
  if (!hasValue(apiKey)) {
    deps.clearSession(deps.runtime, DEEPSEEK_SETUP_MESSAGE);
    deps.runtime.proxyStatus = {
      running: false,
      port: 0,
      error: DEEPSEEK_SETUP_MESSAGE
    };
    finishInitialization(deps);
    return { mode: 'without-deepseek' };
  }

  deps.scheduler.poll('deepseek', 'balance');
  const storedSessionToken = deps.store.get('providers.deepseek.sessionToken') || null;
  deps.restoreSession(deps.runtime, storedSessionToken);

  if (deps.getSessionSnapshot(deps.runtime).loggedIn) {
    deps.scheduler.poll('deepseek', 'usage');
    deps.runtime.proxyStatus = {
      running: true,
      port: 0,
      activeSince: deps.now()
    };
    finishInitialization(deps);
    return { mode: 'deepseek-ready' };
  }

  const message = '请登录平台获取用量';
  deps.clearSession(deps.runtime, message);
  deps.runtime.proxyStatus = { running: false, port: 0, error: message };
  deps.createSessionWindow();
  finishInitialization(deps);
  return { mode: 'deepseek-login-required' };
}

module.exports = {
  DEEPSEEK_SETUP_MESSAGE,
  chooseInitialWindow,
  continueWithoutDeepseek,
  initializeMainRenderer
};
