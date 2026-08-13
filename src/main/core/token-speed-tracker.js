const { normalizeTokenSpeedSettings } = require('./token-speed-settings');

const SAMPLE_INTERVAL_MS = 10000;
const HISTORY_MS = 6 * 60 * 60 * 1000;
const MAX_POINTS_PER_PROVIDER = HISTORY_MS / SAMPLE_INTERVAL_MS;
const DISPLAY_POINTS = 60;
const STORAGE_VERSION = 1;
const PROVIDER_IDS = Object.freeze(['deepseek', 'codex', 'kimi', 'dsh']);

function freshState() {
  return {
    rawDay: null,
    rawTotal: null,
    logicalTotal: 0,
    observed: false,
    sourceStatus: 'collecting',
    delayed: false,
    gapPending: false,
    points: []
  };
}

function freshStates() {
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, freshState()]));
}

function normalizeTotal(value) {
  const total = Number(value);
  return Number.isFinite(total) && total >= 0 ? total : 0;
}

function metricAt(points, currentIndex, windowMs) {
  const current = points[currentIndex];
  if (!current || !current.valid) {
    return {
      status: 'unavailable',
      deltaTokens: null,
      tokensPerMinute: null
    };
  }

  const target = current.time - windowMs;
  let baselineIndex = -1;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (points[index].valid && points[index].time <= target) {
      baselineIndex = index;
      break;
    }
  }

  if (baselineIndex < 0) {
    const first = points.find((point) => point.valid);
    return {
      status: 'collecting',
      coverageMs: first ? Math.max(0, current.time - first.time) : 0,
      deltaTokens: null,
      tokensPerMinute: null
    };
  }

  const baseline = points[baselineIndex];
  const elapsedMs = current.time - baseline.time;
  const deltaTokens = Math.max(0, current.total - baseline.total);
  const crossedGap = points.slice(baselineIndex + 1, currentIndex + 1)
    .some((point) => !point.valid || point.gapBefore);

  return {
    status: 'ok',
    quality: crossedGap ? 'offline' : (current.delayed ? 'delayed' : 'fresh'),
    coverageMs: elapsedMs,
    deltaTokens,
    tokensPerMinute: elapsedMs > 0 ? deltaTokens * 60000 / elapsedMs : 0
  };
}

function clonePoint(point) {
  return {
    time: Number(point.time),
    total: normalizeTotal(point.total),
    valid: point.valid === true,
    gapBefore: point.gapBefore === true,
    delayed: point.delayed === true
  };
}

function createTokenSpeedTracker(options = {}) {
  const now = options.now || Date.now;
  let states = freshStates();

  function requireState(providerId) {
    if (!PROVIDER_IDS.includes(providerId)) {
      throw new RangeError('Unknown token speed provider: ' + providerId);
    }
    return states[providerId];
  }

  function observe(observation) {
    const state = requireState(observation.providerId);
    const total = normalizeTotal(observation.totalTokens);
    const dayKey = String(observation.dayKey || '');

    if (!state.observed) {
      state.rawDay = dayKey;
      state.rawTotal = total;
      state.observed = true;
    } else if (dayKey !== state.rawDay) {
      state.logicalTotal += total;
      state.rawDay = dayKey;
      state.rawTotal = total;
    } else if (total >= state.rawTotal) {
      state.logicalTotal += total - state.rawTotal;
      state.rawTotal = total;
    } else {
      state.rawTotal = total;
      state.gapPending = true;
    }

    if (state.sourceStatus === 'unavailable') state.gapPending = true;
    state.sourceStatus = 'ok';
  }

  function rebaseline(observation) {
    const state = requireState(observation.providerId);
    state.rawDay = String(observation.dayKey || '');
    state.rawTotal = normalizeTotal(observation.totalTokens);
    state.observed = true;
    state.gapPending = true;
    state.sourceStatus = 'ok';
  }

  function markUnavailable(providerId) {
    const state = requireState(providerId);
    state.sourceStatus = 'unavailable';
    state.gapPending = true;
  }

  function setDelayed(providerId, delayed) {
    requireState(providerId).delayed = delayed === true;
  }

  function sample(at = now()) {
    const sampledAt = Number(at);
    PROVIDER_IDS.forEach((providerId) => {
      const state = states[providerId];
      state.points.push({
        time: sampledAt,
        total: state.logicalTotal,
        valid: state.observed && state.sourceStatus !== 'unavailable',
        gapBefore: state.gapPending,
        delayed: state.delayed
      });
      state.gapPending = false;
      state.points = state.points
        .filter((point) => point.time >= sampledAt - HISTORY_MS)
        .slice(-MAX_POINTS_PER_PROVIDER);
    });
  }

  function selectedProviderIds(providerFilter) {
    return providerFilter === 'all' ? PROVIDER_IDS : [providerFilter];
  }

  function getSnapshot(input = {}) {
    const settings = normalizeTokenSpeedSettings(input);
    const at = Number.isFinite(Number(input.at)) ? Number(input.at) : Number(now());
    const windowMs = settings.intervalSeconds * 1000;
    const providerIds = selectedProviderIds(settings.providerFilter);
    const providers = [];
    const series = {};

    providerIds.forEach((providerId) => {
      const state = states[providerId];
      const points = state.points;
      const latestIndex = points.length - 1;
      const sampledMetric = metricAt(points, latestIndex, windowMs);
      const latest = state.sourceStatus === 'unavailable'
        ? {
            status: 'unavailable',
            deltaTokens: null,
            tokensPerMinute: null
          }
        : sampledMetric;
      if (latest.status === 'ok' && state.delayed) latest.quality = 'delayed';
      providers.push(Object.assign({ providerId }, latest));

      const firstDisplayIndex = Math.max(0, points.length - DISPLAY_POINTS);
      series[providerId] = points.slice(firstDisplayIndex).map((point, offset) => {
        const metric = metricAt(points, firstDisplayIndex + offset, windowMs);
        return Object.assign({
          time: point.time,
          quality: metric.quality || metric.status
        }, metric);
      });
    });

    return {
      sampledAt: at,
      intervalSeconds: settings.intervalSeconds,
      providerFilter: settings.providerFilter,
      providers,
      series
    };
  }

  function serialize(at = now()) {
    const serializedStates = {};
    PROVIDER_IDS.forEach((providerId) => {
      const state = states[providerId];
      serializedStates[providerId] = {
        rawDay: state.rawDay,
        rawTotal: state.rawTotal,
        logicalTotal: state.logicalTotal,
        observed: state.observed,
        sourceStatus: state.sourceStatus,
        delayed: state.delayed,
        gapPending: state.gapPending,
        points: state.points.map(clonePoint)
      };
    });
    return {
      version: STORAGE_VERSION,
      savedAt: Number(at),
      states: serializedStates
    };
  }

  function hydrate(payload, at = now()) {
    const restoredAt = Number(at);
    if (!payload || payload.version !== STORAGE_VERSION || !payload.states
      || typeof payload.states !== 'object') {
      return false;
    }
    const savedAt = Number(payload.savedAt);
    if (!Number.isFinite(savedAt) || savedAt < restoredAt - HISTORY_MS) return false;

    const restored = freshStates();
    PROVIDER_IDS.forEach((providerId) => {
      const candidate = payload.states[providerId];
      if (!candidate || typeof candidate !== 'object') return;
      const state = restored[providerId];
      state.rawDay = candidate.rawDay === null || candidate.rawDay === undefined
        ? null
        : String(candidate.rawDay);
      state.rawTotal = candidate.rawTotal === null || candidate.rawTotal === undefined
        ? null
        : normalizeTotal(candidate.rawTotal);
      state.logicalTotal = normalizeTotal(candidate.logicalTotal);
      state.observed = candidate.observed === true;
      state.sourceStatus = candidate.sourceStatus === 'unavailable'
        ? 'unavailable'
        : (state.observed ? 'ok' : 'collecting');
      state.delayed = candidate.delayed === true;
      state.gapPending = candidate.gapPending === true;
      state.points = (Array.isArray(candidate.points) ? candidate.points : [])
        .filter((point) => point && Number.isFinite(Number(point.time)))
        .map(clonePoint)
        .filter((point) => point.time >= restoredAt - HISTORY_MS)
        .slice(-MAX_POINTS_PER_PROVIDER);
    });
    states = restored;
    return true;
  }

  function clear() {
    states = freshStates();
  }

  function getPointCount(providerId) {
    return requireState(providerId).points.length;
  }

  return {
    observe,
    rebaseline,
    markUnavailable,
    setDelayed,
    sample,
    getSnapshot,
    serialize,
    hydrate,
    clear,
    getPointCount
  };
}

module.exports = {
  SAMPLE_INTERVAL_MS,
  HISTORY_MS,
  MAX_POINTS_PER_PROVIDER,
  DISPLAY_POINTS,
  STORAGE_VERSION,
  PROVIDER_IDS,
  createTokenSpeedTracker
};
