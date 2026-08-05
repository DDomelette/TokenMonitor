const test = require('node:test');
const assert = require('node:assert/strict');

function loadPolicy() {
  const modulePath = require.resolve('../src/main/core/proxy-settings');
  delete require.cache[modulePath];
  return require(modulePath);
}

test('proxy selections normalize to one compatible stored representation', () => {
  const {
    SYSTEM_PROXY_VALUE,
    normalizeProxySelection,
    normalizeStoredProxyValue,
    classifyStoredProxyValue
  } = loadPolicy();

  assert.equal(normalizeProxySelection({ mode: 'direct', url: 'http://ignored:80' }), '');
  assert.equal(normalizeProxySelection({ mode: 'system', url: 'http://ignored:80' }), SYSTEM_PROXY_VALUE);
  assert.equal(normalizeProxySelection({ mode: 'custom', url: ' http://Proxy.Example:8080 ' }), 'http://proxy.example:8080');
  assert.equal(normalizeStoredProxyValue(null), '');
  assert.equal(normalizeStoredProxyValue(''), '');
  assert.equal(normalizeStoredProxyValue(SYSTEM_PROXY_VALUE), SYSTEM_PROXY_VALUE);
  assert.deepEqual(classifyStoredProxyValue(''), { mode: 'direct', url: '' });
  assert.deepEqual(classifyStoredProxyValue(SYSTEM_PROXY_VALUE), { mode: 'system', url: '' });
  assert.deepEqual(classifyStoredProxyValue('http://proxy.example:8080'), {
    mode: 'custom',
    url: 'http://proxy.example:8080'
  });
});

test('custom proxy validation rejects unsupported or ambiguous URLs', () => {
  const { normalizeProxySelection } = loadPolicy();
  const invalid = [
    '',
    'proxy.example:8080',
    'https://proxy.example:443',
    'socks5://proxy.example:1080',
    'http://user:pass@proxy.example:8080',
    'http://proxy.example:8080/path',
    'http://proxy.example:8080?token=secret',
    'http://proxy.example:8080#fragment',
    'http://proxy.example:0',
    'http://proxy.example:65536'
  ];

  invalid.forEach((url) => {
    assert.throws(
      () => normalizeProxySelection({ mode: 'custom', url }),
      (error) => {
        assert.equal(error.code, 'INVALID_PROXY_SETTING');
        assert.doesNotMatch(error.message, /secret|user:pass/);
        return true;
      },
      url
    );
  });

  assert.throws(
    () => normalizeProxySelection({ mode: 'unknown', url: '' }),
    (error) => error && error.code === 'INVALID_PROXY_MODE'
  );
});

test('Electron system proxy directives resolve DIRECT and HTTP PROXY safely', () => {
  const { parseSystemProxyResult } = loadPolicy();

  assert.equal(parseSystemProxyResult('DIRECT'), null);
  assert.equal(parseSystemProxyResult('PROXY proxy.example:8080; DIRECT'), 'http://proxy.example:8080');
  assert.equal(parseSystemProxyResult('PROXY 127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseSystemProxyResult(''), null);
});

test('unsupported or malformed system proxy directives fail closed', () => {
  const { parseSystemProxyResult } = loadPolicy();

  for (const result of [
    'SOCKS5 proxy.example:1080',
    'HTTPS proxy.example:443',
    'PROXY missing-port',
    'PROXY proxy.example:70000',
    'UNKNOWN proxy.example:80'
  ]) {
    assert.throws(
      () => parseSystemProxyResult(result),
      (error) => error && error.code === 'UNSUPPORTED_SYSTEM_PROXY',
      result
    );
  }
});

test('live proxy getter reads direct, custom, and system modes on every request', async () => {
  const { createProxyInputGetter } = loadPolicy();
  const values = { 'providers.proxyUrl': '' };
  const resolvedTargets = [];
  const getProxyInput = createProxyInputGetter({
    store: { get: (key) => values[key] },
    resolveSystemProxy: async (targetUrl) => {
      resolvedTargets.push(targetUrl);
      return 'PROXY system.example:3128; DIRECT';
    }
  });

  assert.equal(getProxyInput(), null);
  values['providers.proxyUrl'] = 'http://custom.example:8080';
  assert.equal(getProxyInput(), 'http://custom.example:8080');
  values['providers.proxyUrl'] = 'system';
  const resolver = getProxyInput();
  assert.equal(typeof resolver, 'function');
  assert.equal(await resolver('https://api.example.com/data'), 'http://system.example:3128');
  assert.deepEqual(resolvedTargets, ['https://api.example.com/data']);
});
