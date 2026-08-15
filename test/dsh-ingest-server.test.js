const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startIngestServer } = require('../src/main/providers/dsh/ingest/server');

function post(port, { token, host, body, rawSize }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/v1/dsh/usage', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Host': host || ('127.0.0.1:' + port),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : rawSize);
  });
}

test('requires the correct bearer token and loopback Host', async (t) => {
  const apply = { async handle() { return { ok: true, accepted: 1, duplicates: 0 }; } };
  const srv = await startIngestServer({ host: '127.0.0.1', basePort: 0, maxPort: 0, token: 'tok', apply, logger: { log() {}, error() {} } });
  t.after(() => srv.close());
  const noToken = await post(srv.port, { body: {} });
  assert.equal(noToken.status, 401);
  const badHost = await post(srv.port, { token: 'tok', host: 'evil.example.com', body: {} });
  assert.equal(badHost.status, 403);
});

test('heartbeat and valid batch pass through to the apply handler', async (t) => {
  const seen = [];
  const apply = { async handle(body) { seen.push(body); return body.heartbeat ? { ok: true, heartbeat: true } : { ok: true, accepted: 1, duplicates: 0 }; } };
  const srv = await startIngestServer({ host: '127.0.0.1', basePort: 0, maxPort: 0, token: 'tok', apply, logger: { log() {}, error() {} } });
  t.after(() => srv.close());
  const hb = await post(srv.port, { token: 'tok', body: { sourceId: 's1', rootId: 'root:' + 'a'.repeat(64), sentAt: Date.now(), heartbeat: true, rows: [] } });
  assert.deepEqual(hb.body, { ok: true, heartbeat: true });
  const batch = await post(srv.port, { token: 'tok', body: { sourceId: 's1', rootId: 'root:' + 'a'.repeat(64), sentAt: Date.now(), batchId: 'sha256:' + 'b'.repeat(64), rows: [{ v: 1, time: Date.now(), sessionId: 'x', model: 'deepseek-v4-pro', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }] } });
  assert.equal(batch.body.accepted, 1);
});

test('bodies over 1 MiB get 413 before JSON parsing', async (t) => {
  const apply = { async handle() { throw new Error('must not run'); } };
  const srv = await startIngestServer({ host: '127.0.0.1', basePort: 0, maxPort: 0, token: 'tok', apply, logger: { log() {}, error() {} } });
  t.after(() => srv.close());
  const res = await post(srv.port, { token: 'tok', rawSize: Buffer.alloc(1024 * 1024 + 1, 32) });
  assert.equal(res.status, 413);
  assert.equal(res.body.code, 'batch-too-large');
});
