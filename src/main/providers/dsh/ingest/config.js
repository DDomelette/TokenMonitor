const BASE_PORT = 29351;
const MAX_PORT = 29360;

const DEFAULTS = Object.freeze({
  enabled: true,
  listenHost: '127.0.0.1',
  batchTtlDays: 7,
  pushLeaseMs: 600000,
  rateLimitPerSourcePerMinute: 30
});

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeIngestConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled !== false,
    listenHost: typeof source.listenHost === 'string' && source.listenHost.trim()
      ? source.listenHost.trim()
      : DEFAULTS.listenHost,
    basePort: positiveNumber(source.port, BASE_PORT),
    maxPort: positiveNumber(source.maxPort, MAX_PORT),
    batchTtlDays: positiveNumber(source.batchTtlDays, DEFAULTS.batchTtlDays),
    pushLeaseMs: Math.max(180000, positiveNumber(source.pushLeaseMs, DEFAULTS.pushLeaseMs)),
    rateLimitPerSourcePerMinute: positiveNumber(source.rateLimitPerSourcePerMinute, DEFAULTS.rateLimitPerSourcePerMinute)
  };
}

module.exports = { BASE_PORT, MAX_PORT, normalizeIngestConfig };
