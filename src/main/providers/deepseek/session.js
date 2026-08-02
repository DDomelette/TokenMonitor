// DeepSeek 平台会话捕获:从旧 src/main/index.js 的会话窗口逻辑(index.js:146-190)原样搬迁。
// 嗅探逻辑不变:匹配 /api/v0/usage/ 请求中的非 sk- Bearer token。
// captureSession(ctx) -> Promise<token>;接线(broadcast/store/定时器)由调用方负责。
const { BrowserWindow } = require('electron');

function createSessionWindow() {
  return new BrowserWindow({
    width: 800,
    height: 600,
    show: true,
    center: true,
    title: '登录 DeepSeek 平台',
    webPreferences: {
      partition: 'persist:deepseek-platform',
      contextIsolation: true,
      nodeIntegration: false
    }
  });
}

function captureSession(ctx) {
  const logger = (ctx && ctx.logger) || console;
  return new Promise((resolve, reject) => {
    const win = ctx && typeof ctx.createSessionWindow === 'function'
      ? ctx.createSessionWindow()
      : createSessionWindow();

    const ses = win.webContents.session;
    let settled = false;

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.includes('/api/v0/usage/') && details.requestHeaders['authorization']) {
        const auth = details.requestHeaders['authorization'];
        if (auth.startsWith('Bearer ') && !auth.includes('sk-')) {
          const token = auth.replace('Bearer ', '');
          if (!settled) {
            settled = true;
            logger.log('[session] captured platform token');
            resolve(token);
          }
          try { win.close(); } catch (e) {}
        }
      }
      callback({ requestHeaders: details.requestHeaders });
    });

    win.webContents.on('did-fail-load', (event, code, desc) => {
      if (!settled) {
        settled = true;
        logger.error('[session] platform login load failed:', code, desc);
        reject(new Error('登录窗口加载失败: ' + desc));
      }
    });

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        logger.log('[session] session window closed without token');
        reject(new Error('未捕获到平台会话'));
      }
    });

    win.loadURL('https://platform.deepseek.com/usage');
  });
}

module.exports = { captureSession, createSessionWindow };
