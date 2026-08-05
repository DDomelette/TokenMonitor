const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadDebounce() {
  return require('../src/renderer/js/settings-debounce');
}

function createFakeTimers() {
  let nextId = 1;
  const tasks = new Map();
  const cleared = [];

  return {
    tasks,
    cleared,
    setTimeout(callback, delay) {
      const id = nextId++;
      tasks.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      tasks.delete(id);
    },
    runAll() {
      const pending = Array.from(tasks.entries());
      tasks.clear();
      pending.forEach((entry) => entry[1].callback());
    }
  };
}

test('different settings keys keep independent pending timers and both emit', () => {
  const { createKeyedDebouncer } = loadDebounce();
  const timers = createFakeTimers();
  const emitted = [];
  const queue = createKeyedDebouncer({
    delay: 300,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onEmit(key, value) {
      emitted.push([key, value]);
    }
  });

  queue.schedule('components.balance', false);
  queue.schedule('window.opacity', 82);

  assert.equal(timers.tasks.size, 2);
  assert.deepEqual(timers.cleared, []);
  timers.runAll();
  assert.deepEqual(emitted, [
    ['components.balance', false],
    ['window.opacity', 82]
  ]);
});

test('repeated changes to one key coalesce to the latest value only', () => {
  const { createKeyedDebouncer } = loadDebounce();
  const timers = createFakeTimers();
  const emitted = [];
  const queue = createKeyedDebouncer({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onEmit(key, value) {
      emitted.push([key, value]);
    }
  });

  queue.schedule('data.historyDays', '3');
  queue.schedule('data.historyDays', '7');
  queue.schedule('data.historyDays', '30');

  assert.equal(timers.tasks.size, 1);
  assert.deepEqual(timers.cleared, [1, 2]);
  timers.runAll();
  assert.deepEqual(emitted, [['data.historyDays', '30']]);
});

test('queued updates preserve values used by toggle, slider, password, and select controls', () => {
  const { createKeyedDebouncer } = loadDebounce();
  const timers = createFakeTimers();
  const emitted = [];
  const queue = createKeyedDebouncer({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onEmit(key, value) {
      emitted.push([key, value]);
    }
  });

  queue.schedule('window.alwaysOnTop', true);
  queue.schedule('window.opacity', 75);
  queue.schedule('apiKey', 'sk-partial-value');
  queue.schedule('data.historyDays', '7');
  timers.runAll();

  assert.deepEqual(emitted, [
    ['window.alwaysOnTop', true],
    ['window.opacity', 75],
    ['apiKey', 'sk-partial-value'],
    ['data.historyDays', '7']
  ]);
});

test('settings window loads the keyed helper before the event script', () => {
  const html = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/settings-window.html'),
    'utf8'
  );

  assert.match(
    html,
    /<script src="js\/settings-debounce\.js"><\/script>\s*<script src="js\/settings-window\.js"><\/script>/
  );
});

test('input and custom-select handlers share the keyed queue without a global timer', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-window.js'),
    'utf8'
  );

  assert.doesNotMatch(source, /var debounceTimer\s*=/);
  assert.match(
    source,
    /var settingsUpdateQueue = window\.SettingsDebounce\.createKeyedDebouncer\(\{[\s\S]*?onEmit:\s*function \(key, value\) \{[\s\S]*?window\.api\.send\('settings:update', \{ key: key, value: value \}\);/
  );
  assert.match(
    source,
    /function handleSelectChange\(key, value\) \{\s*settingsUpdateQueue\.schedule\(key, value\);\s*\}/
  );
  assert.match(
    source,
    /function handleChange\(el\)[\s\S]*?settingsUpdateQueue\.schedule\(key, value\);\s*\}/
  );
});
