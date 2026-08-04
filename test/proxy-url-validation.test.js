const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const {
  httpGet,
  parseProxyUrl,
  assertSupportedProxy
} = require('../src/main/core/http');

test('proxy URL parser applies protocol-specific default ports', () => {
  assert.deepEqual(parseProxyUrl('http://proxy.example.com'), {
    protocol: 'http:',
    host: 'proxy.example.com',
    port: 80
  });
  assert.deepEqual(parseProxyUrl('https://proxy.example.com'), {
    protocol: 'https:',
    host: 'proxy.example.com',
    port: 443
  });
});

test('proxy URL parser preserves explicit valid ports', () => {
  assert.deepEqual(parseProxyUrl('http://proxy.example.com:8080'), {
    protocol: 'http:',
    host: 'proxy.example.com',
    port: 8080
  });
  assert.deepEqual(parseProxyUrl('https://proxy.example.com:8443'), {
    protocol: 'https:',
    host: 'proxy.example.com',
    port: 8443
  });
});

test('empty proxy means direct mode while malformed or unsupported URLs fail explicitly', () => {
  assert.equal(parseProxyUrl(null), null);
  assert.equal(parseProxyUrl(''), null);

  assert.throws(
    () => parseProxyUrl('proxy.example.com:7890'),
    /Invalid proxy URL/
  );
  assert.throws(
    () => parseProxyUrl('socks5://proxy.example.com:1080'),
    /Unsupported proxy protocol: socks5:/
  );
  assert.throws(
    () => parseProxyUrl('http://proxy.example.com:70000'),
    /Invalid proxy port/
  );
});

test('HTTPS proxy configuration is rejected before any plaintext proxy connection', async (t) => {
  assert.doesNotThrow(() => assertSupportedProxy(null));
  assert.doesNotThrow(() => assertSupportedProxy(parseProxyUrl('http://proxy.example.com')));
  assert.throws(
    () => assertSupportedProxy(parseProxyUrl('https://proxy.example.com')),
    /HTTPS proxy URLs are not supported; use an http:\/\/ proxy URL/
  );

  const originalConnect = net.connect;
  let connectCalls = 0;
  t.after(() => { net.connect = originalConnect; });
  net.connect = () => {
    connectCalls += 1;
    throw new Error('network connection must not be attempted');
  };

  await assert.rejects(
    httpGet('https://example.com/data', {}, 'https://proxy.example.com'),
    /HTTPS proxy URLs are not supported; use an http:\/\/ proxy URL/
  );
  assert.equal(connectCalls, 0);
});
