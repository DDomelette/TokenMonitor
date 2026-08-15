const RESET_KEEP_KEYS = Object.freeze([
  'providers.deepseek.apiKey',
  'providers.deepseek.sessionToken',
  'providers.proxyUrl',
  'usageDaily',
  // usageDaily is incrementally aggregated from local logs. Compatible cursors
  // and completed data-version migrations are part of the same durable state:
  // retaining the aggregate without them replays or deletes historical usage.
  'localLogCursors.codex',
  'localLogCursors.kimi',
  // DSH 遥测:汇总、费用与游标是同一份持久单元,必须与 usageDaily 一起保留。
  'usageDailyCost',
  'localLogCursors.dsh',
  // DSH ingest:push 账本、幂等注册表与 source 活跃状态属于账务持久单元。
  'usageDailyPush',
  'usageDailyCostPush',
  'ingest.dsh.batchRegistry',
  'ingest.dsh.sources',
  // Codex 归档迁移:汇总、UUID 游标与迁移完成版本是同一份持久单元,必须一起保留;
  // 只保留汇总而丢失标记会导致下次启动重复重建,丢失游标则会重读或漏读历史。
  'localLogMigrations.codexArchiveUuidCursorV1',
  'localLogMigrations.kimiTotalIncludesCached'
]);

function shouldRestore(value) {
  return value !== undefined && value !== '' && value !== null;
}

function resolveElectronApp(appOverride) {
  if (appOverride && typeof appOverride.setLoginItemSettings === 'function') {
    return appOverride;
  }

  try {
    const electron = require('electron');
    if (electron && electron.app
        && typeof electron.app.setLoginItemSettings === 'function') {
      return electron.app;
    }
  } catch (_) {
    // Plain Node tests and unsupported runtimes may not expose Electron APIs.
  }

  return null;
}

function syncAutoLaunchAfterReset(store, appOverride) {
  if (!store || typeof store.get !== 'function') {
    throw new TypeError('syncAutoLaunchAfterReset requires a store with a get method');
  }

  const electronApp = resolveElectronApp(appOverride);
  if (!electronApp) return false;

  const autoLaunch = store.get('window.autoLaunch');
  electronApp.setLoginItemSettings({ openAtLogin: autoLaunch === true });
  return true;
}

function resetSettingsStore(store, options) {
  if (!store || typeof store.get !== 'function'
      || typeof store.set !== 'function' || typeof store.clear !== 'function') {
    throw new TypeError('resetSettingsStore requires a store with get/set/clear methods');
  }

  const kept = new Map();
  RESET_KEEP_KEYS.forEach((key) => {
    const value = store.get(key);
    if (shouldRestore(value)) kept.set(key, value);
  });

  store.clear();
  kept.forEach((value, key) => store.set(key, value));
  syncAutoLaunchAfterReset(store, options && options.app);
  return Array.from(kept.keys());
}

module.exports = {
  RESET_KEEP_KEYS,
  resetSettingsStore,
  resolveElectronApp,
  shouldRestore,
  syncAutoLaunchAfterReset
};
