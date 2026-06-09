const apiKeyInput = document.getElementById('apiKeyInput');
const loginBtn = document.getElementById('loginBtn');
const skipBtn = document.getElementById('skipBtn');
const errorMsg = document.getElementById('errorMsg');

loginBtn.addEventListener('click', () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    errorMsg.textContent = '请输入 API Key';
    return;
  }
  if (!apiKey.startsWith('sk-')) {
    errorMsg.textContent = 'API Key 格式不正确，应以 sk- 开头';
    return;
  }
  loginBtn.disabled = true;
  loginBtn.textContent = '验证中...';
  errorMsg.textContent = '';
  window.api.send('login:submit', { apiKey });
});

window.api.on('login:error', (msg) => {
  errorMsg.textContent = msg;
  loginBtn.disabled = false;
  loginBtn.textContent = '验证并登录';
});

skipBtn.addEventListener('click', () => {
  window.api.send('window:close');
});

apiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') loginBtn.click();
});
