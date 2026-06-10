var apiKeyInput = document.getElementById('apiKeyInput');
var loginBtn = document.getElementById('loginBtn');
var skipBtn = document.getElementById('skipBtn');
var errorMsg = document.getElementById('errorMsg');

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
  window.api.send('window:close');
});

apiKeyInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') loginBtn.click();
});
