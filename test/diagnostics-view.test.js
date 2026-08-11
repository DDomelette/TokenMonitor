const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function diagnosticCheck(status, fields = {}) {
  return Object.assign({
    id: `check.${status}`,
    group: 'Runtime',
    title: `Check ${status}`,
    status,
    summary: `${status} summary`,
    errorCode: status === 'fail' ? 'CHECK_FAILED' : null,
    guideId: 'app-runtime',
    metadata: {}
  }, fields);
}

function classListFor(element) {
  function values() {
    return new Set(String(element.className || '').split(/\s+/).filter(Boolean));
  }
  function write(items) {
    element.className = Array.from(items).join(' ');
  }
  return {
    add(...names) {
      const items = values();
      names.forEach((name) => items.add(name));
      write(items);
    },
    remove(...names) {
      const items = values();
      names.forEach((name) => items.delete(name));
      write(items);
    },
    contains(name) { return values().has(name); },
    toggle(name, enabled) {
      const items = values();
      const next = enabled === undefined ? !items.has(name) : Boolean(enabled);
      if (next) items.add(name); else items.delete(name);
      write(items);
      return next;
    }
  };
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.classList = classListFor(this);
    this.disabled = false;
    this.hidden = false;
    this._textContent = '';
    this._id = '';
  }

  set id(value) {
    this._id = String(value);
    if (this.ownerDocument) this.ownerDocument.ids.set(this._id, this);
  }

  get id() { return this._id; }

  set textContent(value) {
    this._textContent = String(value === undefined || value === null ? '' : value);
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join('');
  }

  set innerHTML(value) {
    this._textContent = '';
    this.children = [];
    const markup = String(value);
    const matches = markup.matchAll(/<([a-z]+)[^>]*\sid="([^"]+)"[^>]*>/gi);
    for (const match of matches) {
      const element = this.ownerDocument.createElement(match[1]);
      element.id = match[2];
      const classMatch = match[0].match(/\sclass="([^"]+)"/i);
      if (classMatch) element.className = classMatch[1];
      if (element.id === 'openDiagnosticsBtn') {
        const row = this.ownerDocument.createElement('div');
        row.className = 'setting-row vertical';
        row.appendChild(element);
        this.appendChild(row);
      } else {
        this.appendChild(element);
      }
    }
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children.forEach((child) => { child.parentElement = null; });
    this.children = [];
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) { return this.attributes[name]; }

  addEventListener(type, listener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  dispatchEvent(event) {
    const value = Object.assign({ type: '', target: this, preventDefault() {}, stopPropagation() {} }, event);
    (this.listeners[value.type] || []).forEach((listener) => listener(value));
  }

  click() { this.dispatchEvent({ type: 'click' }); }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  querySelectorAll(selector) {
    const results = [];
    const matches = (element) => {
      if (selector.startsWith('.')) return element.classList.contains(selector.slice(1));
      if (selector.startsWith('#')) return element.id === selector.slice(1);
      return element.tagName.toLowerCase() === selector.toLowerCase();
    };
    const visit = (element) => {
      element.children.forEach((child) => {
        if (matches(child)) results.push(child);
        visit(child);
      });
    };
    visit(this);
    return results;
  }
}

class FakeDocument {
  constructor(ids = []) {
    this.ids = new Map();
    this.listeners = {};
    this.body = new FakeElement('body', this);
    ids.forEach((id) => {
      const element = this.createElement(id.endsWith('Btn') ? 'button' : 'div');
      element.id = id;
      this.body.appendChild(element);
    });
  }

  createElement(tagName) { return new FakeElement(tagName, this); }
  getElementById(id) { return this.ids.get(id) || null; }
  querySelector(selector) {
    if (selector === 'body') return this.body;
    return this.body.querySelector(selector);
  }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  addEventListener(type, listener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createDiagnosticsHarness(options = {}) {
  const document = new FakeDocument([
    'diagnosticsCloseBtn',
    'diagnosticsSummary',
    'diagnosticsGroups',
    'diagnosticsActionStatus',
    'rerunDiagnosticsBtn',
    'copyDiagnosticsBtn'
  ]);
  const listeners = {};
  const operations = [];
  const snapshots = (options.snapshots || []).slice();
  const invoked = [];
  const sent = [];
  const mediaListeners = [];
  const media = {
    matches: Boolean(options.systemDark),
    addEventListener(type, listener) { if (type === 'change') mediaListeners.push(listener); }
  };
  const api = {
    on(channel, listener) {
      operations.push(`on:${channel}`);
      listeners[channel] = listener;
      return () => {};
    },
    send(channel, payload) { sent.push({ channel, payload }); },
    invoke(channel, ...args) {
      operations.push(`invoke:${channel}`);
      invoked.push({ channel, args });
      if (channel === 'diagnostics:run') return Promise.resolve(snapshots.shift());
      if (channel === 'get:settings') {
        return Promise.resolve(options.settings || { window: { followSystemTheme: true, darkMode: 'system' } });
      }
      if (channel === 'diagnostics:copy-report') return Promise.resolve({ ok: true, length: 100 });
      if (channel === 'diagnostics:open-guide') {
        if (options.guidePromise) return options.guidePromise;
        return Promise.resolve(options.guideResult || { ok: false, errorCode: 'GUIDE_OPEN_FAILED' });
      }
      return Promise.reject(new Error(`Unexpected invoke: ${channel}`));
    }
  };
  const context = {
    window: { api, matchMedia: () => media },
    document,
    DiagnosticsState: require('../src/renderer/js/diagnostics-state.js'),
    DiagnosticsView: require('../src/renderer/js/diagnostics-view.js'),
    ThemeModeLink: require('../src/renderer/js/theme-mode-link.js'),
    Promise,
    console
  };
  context.window.window = context.window;
  context.window.document = document;
  const source = fs.readFileSync(path.join(root, 'src/renderer/js/diagnostics-window.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'diagnostics-window.js' });
  return { document, listeners, operations, invoked, sent, media, mediaListeners };
}

function createSettingsHarness() {
  const document = new FakeDocument([
    'settingsBody', 'settingsCloseBtn', 'settingsDoneBtn', 'resetBtn', 'settingsSaveError', 'app'
  ]);
  const sent = [];
  const invoked = [];
  const listeners = {};
  const context = {
    window: {
      SettingsDefinitions: [
        { group: '诊断', type: 'diagnostics', label: '诊断中心', channel: 'open:diagnostics' }
      ],
      SettingsDebounce: {
        createKeyedDebouncer() {
          return { schedule() { throw new Error('diagnostics action entered settingsUpdateQueue'); }, flush: () => Promise.resolve() };
        }
      },
      ThemeModeLink: require('../src/renderer/js/theme-mode-link.js'),
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      confirm: () => true,
      api: {
        on(channel, listener) { listeners[channel] = listener; return () => {}; },
        send(channel, payload) { sent.push({ channel, payload }); },
        invoke(channel, ...args) {
          invoked.push({ channel, args });
          if (channel === 'get:settings') return Promise.resolve({ window: {} });
          if (channel === 'get:session-state') return Promise.resolve({ loggedIn: false, error: null });
          return Promise.reject(new Error(`Unexpected invoke: ${channel}`));
        }
      }
    },
    document,
    ThemeModeLink: require('../src/renderer/js/theme-mode-link.js'),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    Promise,
    console
  };
  context.window.window = context.window;
  context.window.document = document;
  const source = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'settings-window.js' });
  return { document, sent, invoked };
}

test('rowForCheck exposes the presentation contract for all five statuses', () => {
  const DiagnosticsView = require('../src/renderer/js/diagnostics-view.js');
  const expected = {
    pending: { statusClass: 'status-pending', statusLabel: '等待诊断', showGuide: false },
    running: { statusClass: 'status-running', statusLabel: '正在诊断', showGuide: false },
    pass: { statusClass: 'status-pass', statusLabel: '正常', showGuide: false },
    fail: { statusClass: 'status-fail', statusLabel: '异常', showGuide: true },
    skipped: { statusClass: 'status-skipped', statusLabel: '已跳过', showGuide: false }
  };

  Object.keys(expected).forEach((status) => {
    const row = DiagnosticsView.rowForCheck(diagnosticCheck(status));
    assert.equal(row.id, `check.${status}`);
    assert.equal(row.statusClass, expected[status].statusClass);
    assert.equal(row.statusLabel, expected[status].statusLabel);
    assert.equal(row.showGuide, expected[status].showGuide);
    assert.equal(row.guideId, status === 'fail' ? 'app-runtime' : null);
  });
});

test('groupChecks keeps definition-group order and original check order within each group', () => {
  const DiagnosticsView = require('../src/renderer/js/diagnostics-view.js');
  const checks = [
    diagnosticCheck('pass', { id: 'network.first', group: 'Network' }),
    diagnosticCheck('pass', { id: 'runtime.first', group: 'Runtime' }),
    diagnosticCheck('pass', { id: 'network.second', group: 'Network' }),
    diagnosticCheck('pass', { id: 'storage.first', group: 'Storage' }),
    diagnosticCheck('pass', { id: 'runtime.second', group: 'Runtime' })
  ];
  const definitions = [
    { id: 'runtime.definition', group: 'Runtime' },
    { id: 'storage.definition', group: 'Storage' },
    { id: 'network.definition', group: 'Network' }
  ];

  assert.deepEqual(
    DiagnosticsView.groupChecks(checks, definitions).map((group) => ({
      name: group.name,
      ids: group.checks.map((item) => item.id)
    })),
    [
      { name: 'Runtime', ids: ['runtime.first', 'runtime.second'] },
      { name: 'Storage', ids: ['storage.first'] },
      { name: 'Network', ids: ['network.first', 'network.second'] }
    ]
  );
});

test('settings definitions expose one non-persistent diagnostics action on its declared channel', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/renderer/js/settings-definitions.js'),
    'utf8'
  );
  const context = {
    window: {
      ComponentRegistry: { list: () => [] }
    }
  };

  vm.runInNewContext(source, context, { filename: 'settings-definitions.js' });
  const actions = Array.from(context.window.SettingsDefinitions)
    .filter((definition) => definition.type === 'diagnostics');

  assert.equal(actions.length, 1);
  assert.equal(actions[0].channel, 'open:diagnostics');
  assert.equal(Object.prototype.hasOwnProperty.call(actions[0], 'key'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(actions[0], 'default'), false);
});

test('diagnostics window subscribes before running and renders sanitized result text as text', async () => {
  const harness = createDiagnosticsHarness({
    snapshots: [{
      runId: 'run-one',
      checks: [
        diagnosticCheck('pending', { id: 'runtime.a', group: 'Runtime', summary: '' }),
        diagnosticCheck('pending', { id: 'network.b', group: 'Network', summary: '' })
      ]
    }]
  });
  await flushPromises();

  assert.ok(
    harness.operations.indexOf('on:diagnostics:progress') < harness.operations.indexOf('invoke:diagnostics:run')
  );
  assert.equal(harness.document.getElementById('copyDiagnosticsBtn').disabled, true);

  harness.listeners['diagnostics:progress']({
    runId: 'run-one',
    check: diagnosticCheck('fail', {
      id: 'runtime.a',
      group: 'Runtime',
      summary: '<img src=x onerror=private()>',
      guideId: 'app-runtime'
    })
  });
  harness.listeners['diagnostics:progress']({
    runId: 'run-one',
    check: diagnosticCheck('skipped', {
      id: 'network.b',
      group: 'Network',
      summary: 'Not applicable',
      guideId: 'network-proxy'
    })
  });

  const rootElement = harness.document.getElementById('diagnosticsGroups');
  assert.equal(rootElement.querySelectorAll('img').length, 0);
  assert.match(rootElement.textContent, /<img src=x onerror=private\(\)>/);
  assert.equal(rootElement.querySelectorAll('.guide-link').length, 1);
  assert.equal(rootElement.querySelector('.guide-link').dataset.guideId, 'app-runtime');
  const skipped = rootElement.querySelector('.status-skipped');
  assert.ok(skipped);
  assert.equal(skipped.classList.contains('status-fail'), false);
  assert.equal(skipped.querySelectorAll('.guide-link').length, 0);
  assert.equal(harness.document.getElementById('copyDiagnosticsBtn').disabled, false);
});

test('diagnostics controls use only the active run, declared channels, and stable UI feedback', async () => {
  const harness = createDiagnosticsHarness({
    snapshots: [
      {
        runId: 'run-one',
        checks: [diagnosticCheck('fail', { id: 'runtime.a', guideId: 'app-runtime' })]
      },
      {
        runId: 'run-two',
        checks: [diagnosticCheck('pass', { id: 'runtime.a', guideId: 'app-runtime' })]
      }
    ],
    settings: { window: { followSystemTheme: false, darkMode: 'acrylic-dark' } }
  });
  await flushPromises();

  assert.equal(harness.document.body.dataset.theme, 'acrylic-dark');
  assert.equal(harness.document.body.classList.contains('dark'), true);
  harness.listeners['window:focus-state'](false);
  assert.equal(harness.document.body.dataset.windowActive, 'false');

  harness.document.getElementById('copyDiagnosticsBtn').click();
  await flushPromises();
  assert.deepEqual(harness.invoked.find((call) => call.channel === 'diagnostics:copy-report').args, ['run-one']);
  assert.equal(harness.document.getElementById('diagnosticsActionStatus').textContent, '已复制诊断结果');

  harness.document.getElementById('diagnosticsGroups').querySelector('.guide-link').click();
  await flushPromises();
  assert.deepEqual(harness.invoked.find((call) => call.channel === 'diagnostics:open-guide').args, ['app-runtime']);
  assert.equal(harness.document.getElementById('diagnosticsGroups').querySelector('.guide-feedback').textContent, '无法打开解决手册');

  harness.document.getElementById('diagnosticsCloseBtn').click();
  assert.ok(harness.sent.some((call) => call.channel === 'window:close-diagnostics'));

  harness.document.getElementById('rerunDiagnosticsBtn').click();
  await flushPromises();
  const copyCallsBefore = harness.invoked.filter((call) => call.channel === 'diagnostics:copy-report').length;
  harness.document.getElementById('copyDiagnosticsBtn').click();
  await flushPromises();
  const copyCalls = harness.invoked.filter((call) => call.channel === 'diagnostics:copy-report');
  assert.equal(copyCalls.length, copyCallsBefore + 1);
  assert.deepEqual(copyCalls.at(-1).args, ['run-two']);
});

test('guide failure remains on the current fail row when progress redraws the window', async () => {
  const guide = deferred();
  const harness = createDiagnosticsHarness({
    guidePromise: guide.promise,
    snapshots: [{
      runId: 'run-one',
      checks: [
        diagnosticCheck('fail', { id: 'runtime.a', guideId: 'app-runtime' }),
        diagnosticCheck('pending', { id: 'network.b', group: 'Network', summary: '' })
      ]
    }]
  });
  await flushPromises();

  harness.document.getElementById('diagnosticsGroups').querySelector('.guide-link').click();
  harness.listeners['diagnostics:progress']({
    runId: 'run-one',
    check: diagnosticCheck('pass', { id: 'network.b', group: 'Network' })
  });
  guide.resolve({ ok: false, errorCode: 'GUIDE_OPEN_FAILED' });
  await flushPromises();

  const failRow = harness.document.getElementById('diagnosticsGroups').querySelector('.status-fail');
  assert.equal(failRow.querySelector('.guide-feedback').textContent, '无法打开解决手册');
});

test('settings renders a vertical diagnostics action and sends its channel without saving', async () => {
  const harness = createSettingsHarness();
  await flushPromises();

  const button = harness.document.getElementById('openDiagnosticsBtn');
  assert.ok(button);
  assert.equal(button.parentElement.classList.contains('vertical'), true);
  button.click();

  assert.deepEqual(harness.sent, [{ channel: 'open:diagnostics', payload: undefined }]);
  assert.equal(harness.invoked.some((call) => call.channel === 'settings:save'), false);
});
