// 纯 node http ingest server:loopback Host 白名单 + Bearer + 1 MiB + 每 source 限流。
const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOST_PATTERN = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('batch too large');
        error.status = 413;
        error.code = 'batch-too-large';
        // 不 destroy 请求流,让 handler 能把 413 写回客户端。
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.on('data', () => {});
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (_) {
        const error = new Error('invalid json');
        error.status = 400;
        error.code = 'invalid-json';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function createRateLimiter(limitPerMinute) {
  const buckets = new Map();
  return {
    tryAcquire(sourceId, nowMs) {
      const bucket = buckets.get(sourceId) || { tokens: limitPerMinute, last: nowMs };
      const elapsedMs = Math.max(0, nowMs - bucket.last);
      bucket.tokens = Math.min(limitPerMinute, bucket.tokens + elapsedMs * (limitPerMinute / 60000));
      bucket.last = nowMs;
      if (bucket.tokens < 1) {
        buckets.set(sourceId, bucket);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / (limitPerMinute / 60000)))
        };
      }
      bucket.tokens -= 1;
      buckets.set(sourceId, bucket);
      return { allowed: true, retryAfterSeconds: 0 };
    }
  };
}

function createIngestHandler({ token, apply, rateLimitPerSourcePerMinute, listenHost, onError }) {
  const rateLimiter = createRateLimiter(rateLimitPerSourcePerMinute);
  const allowedHost = typeof listenHost === 'string' && !LOOPBACK_HOST_PATTERN.test(listenHost)
    ? listenHost
    : null;
  return async (req, res) => {
    try {
      const reqHost = String(req.headers.host || '');
      const loopbackAllowed = LOOPBACK_HOST_PATTERN.test(reqHost);
      const customAllowed = allowedHost && (reqHost === allowedHost || reqHost.startsWith(allowedHost + ':'));
      if (!loopbackAllowed && !customAllowed) {
        return sendJson(res, 403, { ok: false, code: 'forbidden', message: 'Host not allowed' });
      }
      if (req.url !== '/api/v1/dsh/usage' || req.method !== 'POST') {
        return sendJson(res, 404, { ok: false, code: 'not-found', message: 'Not Found' });
      }
      if (!req.headers.authorization || !timingSafeEqual(req.headers.authorization, 'Bearer ' + token)) {
        return sendJson(res, 401, { ok: false, code: 'unauthorized', message: 'Unauthorized' });
      }
      const body = await readBody(req);
      if (!body || typeof body !== 'object') {
        return sendJson(res, 400, { ok: false, code: 'invalid-envelope', message: 'body must be a JSON object' });
      }
      const limit = rateLimiter.tryAcquire(String(body.sourceId || 'unknown'), Date.now());
      if (!limit.allowed) {
        if (typeof onError === 'function') onError('rate-limited');
        res.writeHead(429, {
          'Content-Type': 'application/json; charset=utf-8',
          'Retry-After': String(limit.retryAfterSeconds)
        });
        return res.end(JSON.stringify({ ok: false, code: 'rate-limited', message: 'Rate limited' }));
      }
      const result = await apply.handle(body);
      sendJson(res, 200, result);
    } catch (error) {
      const status = Number(error && error.status) || 500;
      const code = error && error.code ? error.code : 'internal';
      if (typeof onError === 'function') onError(code);
      if (res.headersSent || res.destroyed) return;
      const message = status >= 500 ? 'Internal Server Error' : String(error && error.message || 'bad request');
      const payload = { ok: false, code, message };
      if (error && error.index !== undefined) payload.index = error.index;
      sendJson(res, status, payload);
    }
  };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

async function startIngestServer(options) {
  const host = options.host || '127.0.0.1';
  const basePort = Number(options.basePort) || 0;
  const maxPort = options.maxPort || basePort;
  const handler = createIngestHandler({
    token: options.token,
    apply: options.apply,
    rateLimitPerSourcePerMinute: options.rateLimitPerSourcePerMinute || 30,
    listenHost: host,
    onError: options.onError,
    logger: options.logger || console
  });
  let lastError = null;
  for (let port = basePort; port <= maxPort; port++) {
    const server = http.createServer(handler);
    try {
      await listen(server, host, port || 0);
      const actual = server.address().port;
      return {
        port: actual,
        url: 'http://' + host + ':' + actual + '/api/v1/dsh/usage',
        close: () => new Promise((resolve) => server.close(resolve))
      };
    } catch (error) {
      lastError = error;
      try { server.close(); } catch (_) {}
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    }
  }
  if (basePort) {
    const server = http.createServer(handler);
    await listen(server, host, 0);
    const actual = server.address().port;
    return {
      port: actual,
      url: 'http://' + host + ':' + actual + '/api/v1/dsh/usage',
      close: () => new Promise((resolve) => server.close(resolve))
    };
  }
  throw lastError || new Error('no available port');
}

module.exports = { startIngestServer, MAX_BODY_BYTES };
