// 临时调试脚本:用项目自身的 store 初始化逻辑(含 .key 解密)读取真实配置的只读摘要。
(async () => {
  const path = require('path');
  const os = require('os');
  const { initializeStore } = require('../src/main/core/store-recovery');
  const mod = await import('electron-store');
  const StoreClass = mod.default || mod;
  const userDataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'deepseek-monitor');
  const store = initializeStore({ StoreClass, userDataDir, defaults: {} });
  console.log('historyDays =', store.get('data.historyDays'));
  console.log('fetchedMonths =', JSON.stringify(store.get('providers.deepseek.fetchedMonths')));
  const ud = store.get('usageDaily') || {};
  const per = {};
  Object.keys(ud).forEach((k) => {
    const idx = k.indexOf(':');
    const pid = k.slice(0, idx);
    const date = k.slice(idx + 1);
    (per[pid] = per[pid] || []).push(date);
  });
  Object.keys(per).forEach((pid) => {
    const d = per[pid].sort();
    console.log(pid, 'days:', d.length, 'range:', d[0], '->', d[d.length - 1]);
  });
})().catch((e) => {
  console.error('read failed:', e && e.message, e && e.code);
  process.exit(1);
});
