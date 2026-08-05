var apiKeyInput = document.getElementById('apiKeyInput');
var loginBtn = document.getElementById('loginBtn');
var skipBtn = document.getElementById('skipBtn');
var errorMsg = document.getElementById('errorMsg');

// 主题与主窗口/设置窗口一致:followSystemTheme 为主开关
// (语义同 renderer/src/theme-sync.js),theme:changed 仅作唤醒信号。
var themeSettings = null;
var systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  var windowValues = (themeSettings && themeSettings.window) || {};
  var theme = ThemeModeLink.resolveTheme(windowValues, systemThemeMedia.matches);
  document.body.classList.toggle('dark', theme === 'dark');
}

window.api.invoke('get:settings').then(function (settings) {
  themeSettings = settings;
  applyTheme();
}).catch(function () {
  applyTheme();
});

window.api.on('settings:loaded', function (settings) {
  themeSettings = settings;
  applyTheme();
});

window.api.on('theme:changed', function () {
  applyTheme();
});

systemThemeMedia.addEventListener('change', function () {
  applyTheme();
});

applyTheme();

loginBtn.addEventListener('click', function () {
  var apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    errorMsg.textContent = '请输入 API Key';
    return;
  }
  if (apiKey.indexOf('sk-') !== 0) {
    errorMsg.textContent = 'API Key 格式不正确，应以 sk- 开头';
    return;
  }
  loginBtn.disabled = true;
  loginBtn.textContent = '验证中...';
  errorMsg.textContent = '';
  window.api.send('login:submit', { apiKey: apiKey });
});

window.api.on('login:error', function (msg) {
  errorMsg.textContent = msg;
  loginBtn.disabled = false;
  loginBtn.textContent = '验证并登录';
});

skipBtn.addEventListener('click', function () {
  window.api.send('login:skip');
});

apiKeyInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') loginBtn.click();
});
