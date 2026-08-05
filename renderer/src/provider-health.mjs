function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function latestSuccessfulFetch(providers) {
  return providers.reduce((latest, provider) => {
    const timestamp = finiteTimestamp(provider && provider.lastFetchedAt);
    return timestamp && (!latest || timestamp > latest) ? timestamp : latest;
  }, null);
}

function latestFailure(providers) {
  return providers
    .filter((provider) => provider && provider.lastError)
    .reduce((latest, provider) => {
      const failedAt = finiteTimestamp(provider.lastFailedAt) || 0;
      const latestAt = latest ? (finiteTimestamp(latest.lastFailedAt) || 0) : -1;
      return !latest || failedAt >= latestAt ? provider : latest;
    }, null);
}

export function summarizeProviderHealth(snapshot) {
  const providers = Array.isArray(snapshot) ? snapshot : [];
  const lastFetchedAt = latestSuccessfulFetch(providers);
  const staleFailure = latestFailure(
    providers.filter((provider) => provider && provider.stale)
  );
  const failed = staleFailure || latestFailure(providers);

  if (failed) {
    const name = failed.displayName || failed.id || '平台';
    const message = String(failed.lastError);
    const stale = !!failed.stale;
    return {
      mode: stale ? 'stale' : 'error',
      running: false,
      text: stale
        ? `数据可能已过期：${name} ${message}`
        : `获取失败：${name} ${message}`,
      lastFetchedAt
    };
  }

  if (lastFetchedAt) {
    return {
      mode: 'online',
      running: true,
      text: '数据连接正常',
      lastFetchedAt
    };
  }

  return {
    mode: 'offline',
    running: false,
    text: '未获取数据',
    lastFetchedAt: null
  };
}
