// dsh 采集模式与 localLog 抑制判断。source 活跃状态由 ingest apply 写入 store。
const path = require('node:path');
const crypto = require('node:crypto');

const MODES = new Set(['auto', 'localLog', 'push']);
const DEFAULT_PUSH_LEASE_MS = 600000;
const MIN_PUSH_LEASE_MS = 180000;

function normalizeDshCollectionMode(value) {
  return MODES.has(value) ? value : 'auto';
}

function canonicalRootPath(rootPath, platform) {
  const abs = path.resolve(String(rootPath || ''));
  if (platform === 'win32') return abs.replace(/\\/g, '/').toLowerCase();
  return abs;
}

function deriveDshRootId(rootPath, platform = process.platform) {
  return 'root:' + crypto.createHash('sha256')
    .update(canonicalRootPath(rootPath, platform), 'utf8')
    .digest('hex');
}

function normalizePushLeaseMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= MIN_PUSH_LEASE_MS ? n : DEFAULT_PUSH_LEASE_MS;
}

function isDshPushSourceActive(source, nowMs, pushLeaseMs) {
  const last = Number(source && source.lastIngestAt);
  const lease = normalizePushLeaseMs(pushLeaseMs);
  return Number.isFinite(last) && nowMs - last < lease;
}

function shouldPollDshLocalLog(store, rootPath, nowMs = Date.now()) {
  const mode = normalizeDshCollectionMode(store.get('providers.dsh.collectionMode'));
  if (mode === 'localLog') return true;
  if (mode === 'push') return false;
  const rootId = deriveDshRootId(rootPath, process.platform);
  const sources = store.get('ingest.dsh.sources') || {};
  const lease = normalizePushLeaseMs(store.get('ingest.dsh.pushLeaseMs'));
  return !Object.keys(sources).some((sourceId) =>
    sources[sourceId]
    && sources[sourceId].rootId === rootId
    && isDshPushSourceActive(sources[sourceId], nowMs, lease));
}

module.exports = {
  normalizeDshCollectionMode,
  deriveDshRootId,
  normalizePushLeaseMs,
  isDshPushSourceActive,
  shouldPollDshLocalLog
};
