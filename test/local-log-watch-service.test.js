const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLocalLogWatchService } = require('../src/main/core/local-log-watch-service');

function harness() {
  const callbacks = [];
  const statuses = [];
  const watchers = [];
  const timers = [];
  const providers = ['codex', 'kimi'].map((id) => ({
    id,
    capabilities: { localLog: true },
    localLogRoot() { return '/logs/' + id; }
  }));
  const fsImpl = {
    existsSync() { return true; },
    watch(root, options, callback) {
      const watcher = new EventEmitter();
      watcher.root = root;
      watcher.close = () => watcher.emit('close');
      watcher.fire = callback;
      watchers.push(watcher);
      return watcher;
    }
  };
  const service = createLocalLogWatchService({
    registry: { list: () => providers, get: (id) => providers.find((item) => item.id === id) },
    store: { get() { return undefined; } },
    fsImpl,
    onProviderChanged(id) { callbacks.push(id); },
    onStatus(id, status) { statuses.push({ id, status }); },
    setTimeoutFn(fn) { timers.push(fn); return timers.length; },
    clearTimeoutFn() {}
  });
  return { service, callbacks, statuses, watchers, timers };
}

test('start watches Codex and Kimi roots recursively', () => {
  const h = harness();
  h.service.start();
  assert.deepEqual(h.watchers.map((watcher) => watcher.root), ['/logs/codex', '/logs/kimi']);
});

test('bursty file events debounce into one provider scan', () => {
  const h = harness();
  h.service.start();
  h.watchers[0].fire('change', 'a.jsonl');
  h.watchers[0].fire('change', 'a.jsonl');
  h.timers.at(-1)();
  assert.deepEqual(h.callbacks, ['codex']);
});

test('watch errors mark delayed and a later ensure reconnects', () => {
  const h = harness();
  h.service.start();
  h.watchers[0].emit('error', new Error('watch failed'));
  assert.equal(h.service.getStatus('codex').delayed, true);
  assert.equal(h.statuses.at(-1).status.reason, 'watch-error');
  h.service.ensure('codex');
  assert.equal(h.watchers.length, 3);
  assert.equal(h.service.getStatus('codex').delayed, false);
});

test('stop closes every watcher and cancels pending callbacks', () => {
  const h = harness();
  h.service.start();
  h.watchers[0].fire('change', 'a.jsonl');
  h.service.stop();
  assert.equal(h.service.getStatus('codex').watching, false);
  assert.equal(h.service.getStatus('kimi').watching, false);
});
