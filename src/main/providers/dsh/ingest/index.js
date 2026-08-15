// ingest runtime:config/token/apply/server 装配。commitExclusive 与 localLog 共用
// scheduler.runExclusive('dsh','localLog'),保证 ingest/localLog/手动重扫串行。
const { normalizeIngestConfig, BASE_PORT, MAX_PORT } = require('./config');
const { ensureIngestToken, rotateIngestToken, INGEST_TOKEN_KEY } = require('./token');
const { createIngestApply } = require('./apply');
const { startIngestServer } = require('./server');

function startIngest(options = {}) {
  const store = options.store;
  const scheduler = options.scheduler;
  const logger = options.logger || console;
  let server = null;
  let apply = null;
  const diagnostics = Object.create(null);

  function config() {
    return normalizeIngestConfig(store.get('ingest.dsh') || {});
  }

  function commitExclusive(fn) {
    return scheduler && typeof scheduler.runExclusive === 'function'
      ? scheduler.runExclusive('dsh', 'localLog', fn)
      : fn();
  }

  function recordDiagnostic(code) {
    diagnostics[code] = (Number(diagnostics[code]) || 0) + 1;
    store.set('ingest.dsh.diagnostics', JSON.parse(JSON.stringify(diagnostics)));
  }

  async function start() {
    const cfg = config();
    if (server || !cfg.enabled) return;
    apply = createIngestApply({
      store,
      commitExclusive,
      now: options.now || Date.now,
      onAccepted: ({ changed }) => {
        if (!changed) return;
        if (options.onUsageObservation) options.onUsageObservation('dsh', { observedAt: Date.now() });
        if (options.broadcast) options.broadcast('providers:changed', scheduler ? scheduler.getSnapshot() : []);
      },
      onRejected: ({ code }) => recordDiagnostic(code)
    });
    try {
      apply.pruneStoredRegistry();
      const token = ensureIngestToken(store);
      server = await startIngestServer({
        host: cfg.listenHost,
        basePort: options.basePort || cfg.basePort,
        maxPort: options.basePort ? options.basePort : cfg.maxPort,
        token,
        apply,
        rateLimitPerSourcePerMinute: cfg.rateLimitPerSourcePerMinute,
        onError: (code) => recordDiagnostic(code),
        logger
      });
      logger.log('[ingest] listening at ' + server.url);
    } catch (error) {
      logger.error('[ingest] failed to start: ' + (error && error.message));
      server = null;
    }
  }

  async function stop() {
    if (!server) return;
    const current = server;
    server = null;
    await current.close();
  }

  return {
    start,
    stop,
    isRunning: () => !!server,
    getConnectionInfo() {
      return {
        enabled: config().enabled,
        running: !!server,
        listenHost: config().listenHost,
        port: server ? server.port : null,
        url: server ? server.url : null,
        token: store.get(INGEST_TOKEN_KEY) || null,
        diagnostics: JSON.parse(JSON.stringify(diagnostics))
      };
    },
    async rotateToken() {
      const token = rotateIngestToken(store);
      if (server) {
        await stop();
        await start();
      }
      return token;
    },
    handle: (body) => (apply ? apply.handle(body) : Promise.reject(new Error('ingest not running')))
  };
}

module.exports = { startIngest, BASE_PORT, MAX_PORT };
