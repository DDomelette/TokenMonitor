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

function decodeHtmlText(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

class FakeTextNode {
  constructor(text) {
    this.tagName = '#TEXT';
    this.children = [];
    this.parentElement = null;
    this.textContent = decodeHtmlText(text);
  }
}

function parseMarkup(parent, markup) {
  const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
  const stack = [parent];
  const tokens = String(markup).match(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>|[^<]+/gi) || [];

  tokens.forEach((token) => {
    if (token.startsWith('<!--')) return;
    if (token.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      return;
    }
    if (!token.startsWith('<')) {
      if (token) stack.at(-1).appendChild(new FakeTextNode(token));
      return;
    }

    const opening = token.match(/^<([a-z][\w-]*)([\s\S]*?)\/?\s*>$/i);
    if (!opening) return;
    const element = parent.ownerDocument.createElement(opening[1]);
    const attributes = opening[2];
    const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let attribute;
    while ((attribute = attributePattern.exec(attributes)) !== null) {
      const name = attribute[1];
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      element.setAttribute(name, decodeHtmlText(value));
    }
    stack.at(-1).appendChild(element);

    const tagName = opening[1].toLowerCase();
    if (!token.endsWith('/>') && !voidElements.has(tagName)) stack.push(element);
  });
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
    this.replaceChildren();
    parseMarkup(this, value);
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
    const normalizedName = String(name).toLowerCase();
    const normalizedValue = String(value);
    this.attributes[normalizedName] = normalizedValue;
    if (normalizedName === 'id') this.id = normalizedValue;
    if (normalizedName === 'class') this.className = normalizedValue;
    if (normalizedName === 'style') {
      normalizedValue.split(';').forEach((declaration) => {
        const separator = declaration.indexOf(':');
        if (separator === -1) return;
        const key = declaration.slice(0, separator).trim();
        const styleValue = declaration.slice(separator + 1).trim();
        if (key) this.style[key] = styleValue;
      });
    }
    if (normalizedName.startsWith('data-')) {
      const key = normalizedName.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = normalizedValue;
    }
    if (normalizedName === 'type' || normalizedName === 'value') this[normalizedName] = normalizedValue;
    if (['checked', 'disabled', 'hidden'].includes(normalizedName)) this[normalizedName] = true;
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

  click() {
    if (!this.disabled) this.dispatchEvent({ type: 'click' });
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  querySelectorAll(selector) {
    const results = [];
    const matches = (element) => {
      if (element.tagName === '#TEXT') return false;
      if (selector.startsWith('.')) {
        return selector.slice(1).split('.').every((name) => element.classList.contains(name));
      }
      if (selector.startsWith('#')) return element.id === selector.slice(1);
      const attributeSelector = selector.match(/^([a-z][\w-]*)?\[([^\]=]+)(?:=['"]?([^\]'"\]]+)['"]?)?\]$/i);
      if (attributeSelector) {
        const tagMatches = !attributeSelector[1] || element.tagName.toLowerCase() === attributeSelector[1].toLowerCase();
        const actual = element.getAttribute(attributeSelector[2]);
        return tagMatches && actual !== undefined &&
          (attributeSelector[3] === undefined || actual === attributeSelector[3]);
      }
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
  const runPromises = (options.runPromises || []).slice();
  const copyPromises = (options.copyPromises || []).slice();
  const guidePromises = (options.guidePromises || []).slice();
  const invoked = [];
  const sent = [];
  const genericApiAccesses = [];
  const mediaListeners = [];
  const media = {
    matches: Boolean(options.systemDark),
    addEventListener(type, listener) { if (type === 'change') mediaListeners.push(listener); }
  };
  const api = {
    on(channel, listener) {
      genericApiAccesses.push(`on:${channel}`);
      operations.push(`on:${channel}`);
      listeners[channel] = listener;
      return () => {};
    },
    send(channel, payload) { sent.push({ channel, payload }); },
    invoke(channel, ...args) {
      genericApiAccesses.push(`invoke:${channel}`);
      operations.push(`invoke:${channel}`);
      invoked.push({ channel, args });
      if (channel === 'diagnostics:run') {
        return runPromises.length ? runPromises.shift() : Promise.resolve(snapshots.shift());
      }
      if (channel === 'get:settings') {
        return Promise.resolve(options.settings || { window: { followSystemTheme: true, darkMode: 'system' } });
      }
      if (channel === 'diagnostics:copy-report') {
        return copyPromises.length ? copyPromises.shift() : Promise.resolve({ ok: true, length: 100 });
      }
      if (channel === 'diagnostics:open-guide') {
        if (guidePromises.length) return guidePromises.shift();
        if (options.guidePromise) return options.guidePromise;
        return Promise.resolve(options.guideResult || { ok: false, errorCode: 'GUIDE_OPEN_FAILED' });
      }
      return Promise.reject(new Error(`Unexpected invoke: ${channel}`));
    }
  };
  const diagnosticsApi = {
    onProgress(listener) {
      operations.push('on:diagnostics:progress');
      listeners['diagnostics:progress'] = listener;
      return () => {};
    },
    onThemeChanged(listener) {
      operations.push('on:theme:changed');
      listeners['theme:changed'] = listener;
      return () => {};
    },
    onFocusState(listener) {
      operations.push('on:window:focus-state');
      listeners['window:focus-state'] = listener;
      return () => {};
    },
    run() {
      operations.push('invoke:diagnostics:run');
      invoked.push({ channel: 'diagnostics:run', args: [] });
      return runPromises.length ? runPromises.shift() : Promise.resolve(snapshots.shift());
    },
    copyReport(runId) {
      operations.push('invoke:diagnostics:copy-report');
      invoked.push({ channel: 'diagnostics:copy-report', args: [runId] });
      return copyPromises.length ? copyPromises.shift() : Promise.resolve({ ok: true, length: 100 });
    },
    openGuide(guideId) {
      operations.push('invoke:diagnostics:open-guide');
      invoked.push({ channel: 'diagnostics:open-guide', args: [guideId] });
      if (guidePromises.length) return guidePromises.shift();
      if (options.guidePromise) return options.guidePromise;
      return Promise.resolve(options.guideResult || { ok: false, errorCode: 'GUIDE_OPEN_FAILED' });
    },
    getTheme() {
      operations.push('invoke:diagnostics:get-theme');
      invoked.push({ channel: 'diagnostics:get-theme', args: [] });
      return Promise.resolve(options.themeProjection || { window: { followSystemTheme: true, darkMode: 'system' } });
    },
    close() { sent.push({ channel: 'window:close-diagnostics', payload: undefined }); }
  };
  const context = {
    window: { api, diagnosticsApi, matchMedia: () => media },
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
  return { document, listeners, operations, invoked, sent, media, mediaListeners, genericApiAccesses };
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

test('only a running diagnostics row renders one accessible spinner element', async () => {
  const statuses = ['pending', 'running', 'pass', 'fail', 'skipped'];
  const harness = createDiagnosticsHarness({
    snapshots: [{
      runId: 'spinner-run',
      checks: statuses.map((status) => diagnosticCheck(status))
    }]
  });
  await flushPromises();

  const groups = harness.document.getElementById('diagnosticsGroups');
  const runningRow = groups.querySelector('.status-running');
  const runningSpinners = runningRow.querySelectorAll('.diagnostic-spinner');
  assert.equal(runningSpinners.length, 1);
  assert.equal(runningSpinners[0].getAttribute('role'), 'status');
  assert.ok(runningSpinners[0].getAttribute('aria-label'));
  ['pending', 'pass', 'fail', 'skipped'].forEach((status) => {
    assert.equal(groups.querySelector(`.status-${status}`).querySelectorAll('.diagnostic-spinner').length, 0);
  });
});

test('diagnostics renderer uses only the narrow bridge and never requests or receives full settings', async () => {
  const fullSettings = {
    window: { followSystemTheme: false, darkMode: 'acrylic-dark' },
    providers: { codex: { localLogRoot: 'C:\\Users\\Alice\\.codex' } },
    localLogCursors: { 'C:\\Users\\Alice\\.codex\\sessions\\rollout.jsonl': 99 },
    mcp: { token: 'mcp-private' }
  };
  const harness = createDiagnosticsHarness({
    snapshots: [{ runId: 'narrow-run', checks: [] }],
    settings: fullSettings,
    themeProjection: { window: { followSystemTheme: false, darkMode: 'acrylic-dark' } }
  });
  await flushPromises();

  assert.deepEqual(harness.genericApiAccesses, []);
  assert.equal(harness.invoked.some((call) => call.channel === 'get:settings'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(harness.listeners, 'settings:loaded'), false);
  assert.equal(harness.document.body.dataset.theme, 'acrylic-dark');
  assert.doesNotMatch(JSON.stringify(harness.invoked), /Alice|rollout|mcp-private/);
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
    themeProjection: { window: { followSystemTheme: false, darkMode: 'acrylic-dark' } }
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

test('rerun synchronously invalidates the accepted run before its replacement snapshot arrives', async () => {
  const rerun = deferred();
  const harness = createDiagnosticsHarness({
    runPromises: [
      Promise.resolve({
        runId: 'old-run',
        checks: [diagnosticCheck('pending', { id: 'runtime.a', summary: '' })]
      }),
      rerun.promise
    ]
  });
  await flushPromises();

  harness.document.getElementById('rerunDiagnosticsBtn').click();
  assert.equal(harness.document.getElementById('diagnosticsSummary').textContent, '准备诊断…');
  assert.equal(harness.document.getElementById('diagnosticsGroups').textContent, '');

  harness.listeners['diagnostics:progress']({
    runId: 'old-run',
    check: diagnosticCheck('fail', { id: 'runtime.a', summary: 'stale progress' })
  });
  assert.doesNotMatch(harness.document.getElementById('diagnosticsGroups').textContent, /stale progress/);

  rerun.resolve({
    runId: 'new-run',
    checks: [diagnosticCheck('pass', { id: 'runtime.a', summary: 'current result' })]
  });
  await flushPromises();
});

test('an older diagnostics run continuation cannot replace the latest generation', async () => {
  const older = deferred();
  const latest = deferred();
  const harness = createDiagnosticsHarness({
    runPromises: [
      Promise.resolve({
        runId: 'initial-run',
        checks: [diagnosticCheck('pass', { id: 'runtime.a', summary: 'initial result' })]
      }),
      older.promise,
      latest.promise
    ]
  });
  await flushPromises();

  const rerunButton = harness.document.getElementById('rerunDiagnosticsBtn');
  rerunButton.dispatchEvent({ type: 'click' });
  rerunButton.dispatchEvent({ type: 'click' });
  latest.resolve({
    runId: 'latest-run',
    checks: [diagnosticCheck('pass', { id: 'runtime.a', summary: 'latest result' })]
  });
  await flushPromises();
  older.resolve({
    runId: 'older-run',
    checks: [diagnosticCheck('fail', { id: 'runtime.a', summary: 'older result' })]
  });
  await flushPromises();

  const groups = harness.document.getElementById('diagnosticsGroups');
  assert.match(groups.textContent, /latest result/);
  assert.doesNotMatch(groups.textContent, /older result/);
  assert.equal(rerunButton.disabled, false);
  assert.equal(harness.document.getElementById('copyDiagnosticsBtn').disabled, false);
});

test('guide and copy completions from an old generation cannot update a rerun with the same runId', async () => {
  const rerun = deferred();
  const copy = deferred();
  const guide = deferred();
  const harness = createDiagnosticsHarness({
    runPromises: [
      Promise.resolve({
        runId: 'reused-run',
        checks: [diagnosticCheck('fail', { id: 'runtime.a', summary: 'old result' })]
      }),
      rerun.promise
    ],
    copyPromises: [copy.promise],
    guidePromises: [guide.promise]
  });
  await flushPromises();

  harness.document.getElementById('copyDiagnosticsBtn').click();
  harness.document.getElementById('diagnosticsGroups').querySelector('.guide-link').click();
  harness.document.getElementById('rerunDiagnosticsBtn').click();
  rerun.resolve({
    runId: 'reused-run',
    checks: [diagnosticCheck('fail', { id: 'runtime.a', summary: 'new result' })]
  });
  await flushPromises();

  copy.resolve({ ok: true, length: 100 });
  guide.resolve({ ok: false, errorCode: 'GUIDE_OPEN_FAILED' });
  await flushPromises();

  const groups = harness.document.getElementById('diagnosticsGroups');
  assert.match(groups.textContent, /new result/);
  assert.equal(groups.querySelector('.guide-feedback').textContent, '');
  assert.equal(harness.document.getElementById('diagnosticsActionStatus').textContent, '');
  assert.equal(harness.document.getElementById('rerunDiagnosticsBtn').disabled, false);
  assert.equal(harness.document.getElementById('copyDiagnosticsBtn').disabled, false);
});

test('settings renders a vertical diagnostics action and sends its channel without saving', async () => {
  const harness = createSettingsHarness();
  await flushPromises();

  const button = harness.document.getElementById('openDiagnosticsBtn');
  assert.ok(button);
  assert.equal(button.parentElement.classList.contains('vertical'), true);
  assert.equal(button.style.width, '100%');
  button.click();

  assert.deepEqual(harness.sent, [{ channel: 'open:diagnostics', payload: undefined }]);
  assert.equal(harness.invoked.some((call) => call.channel === 'settings:save'), false);
});
