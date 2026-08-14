const INTERVAL_SECONDS = Object.freeze([10, 20, 30, 60, 180, 300, 3600, 18000]);
const PROVIDER_FILTERS = Object.freeze(['all', 'deepseek', 'codex', 'kimi']);
const DEFAULT_TOKEN_SPEED_SETTINGS = Object.freeze({
  intervalSeconds: 30,
  providerFilter: 'all'
});

function normalizeIntervalSeconds(value) {
  const number = Number(value);
  return INTERVAL_SECONDS.includes(number)
    ? number
    : DEFAULT_TOKEN_SPEED_SETTINGS.intervalSeconds;
}

function normalizeProviderFilter(value) {
  return PROVIDER_FILTERS.includes(value)
    ? value
    : DEFAULT_TOKEN_SPEED_SETTINGS.providerFilter;
}

function normalizeTokenSpeedSettings(value) {
  const candidate = value && typeof value === 'object' ? value : {};
  return {
    intervalSeconds: normalizeIntervalSeconds(candidate.intervalSeconds),
    providerFilter: normalizeProviderFilter(candidate.providerFilter)
  };
}

module.exports = {
  INTERVAL_SECONDS,
  PROVIDER_FILTERS,
  DEFAULT_TOKEN_SPEED_SETTINGS,
  normalizeIntervalSeconds,
  normalizeProviderFilter,
  normalizeTokenSpeedSettings
};
