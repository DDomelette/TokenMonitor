const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const { UsageFetcher } = require('../src/main/providers/deepseek/usage');

function installStatusResponse(t, statusCode, requestedPaths) {
  const originalRequest = https.request;
  https.request = (options, onResponse) => {
    requestedPaths.push(options.path);
    const request = new EventEmitter();
    request.destroyed = false;
    request.setTimeout = () => request;
    request.write = () => true;
    request.destroy = () => { request.destroyed = true; };
    request.end = () => {
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = statusCode;
        onResponse(response);
        response.emit('data', Buffer.from('{"message":"upstream failure"}'));
        response.emit('end');
      });
    };
    return request;
  };
  t.after(() => { https.request = originalRequest; });
}

for (const statusCode of [429, 502]) {
  test(`HTTP ${statusCode} usage response rejects without previous-month fallback`, async (t) => {
    const requestedPaths = [];
    installStatusResponse(t, statusCode, requestedPaths);

    await assert.rejects(
      new UsageFetcher().fetchUsageWithFallback('session-token', 8, 2026),
      new RegExp(`HTTP ${statusCode}`)
    );
    assert.deepEqual(requestedPaths, ['/api/v0/usage/cost?month=8&year=2026']);
  });
}
