async function replaceDeepseekApiKey(deps, payload) {
  if (!deps || !deps.store || typeof deps.store.set !== 'function') {
    throw new TypeError('replaceDeepseekApiKey requires a writable settings store');
  }
  if (typeof deps.verifyApiKey !== 'function') {
    throw new TypeError('replaceDeepseekApiKey requires a verification function');
  }

  const candidate = payload && typeof payload.apiKey === 'string'
    ? payload.apiKey.trim()
    : '';
  if (!candidate) {
    const error = new Error('API key is required');
    error.code = 'API_KEY_REQUIRED';
    throw error;
  }

  const verified = await deps.verifyApiKey(candidate);
  if (!verified) {
    const error = new Error('API key verification failed');
    error.code = 'API_KEY_INVALID';
    throw error;
  }

  deps.store.set('providers.deepseek.apiKey', candidate);
  if (typeof deps.broadcastSettings === 'function') {
    deps.broadcastSettings();
  }
  return { ok: true };
}

module.exports = {
  replaceDeepseekApiKey
};
