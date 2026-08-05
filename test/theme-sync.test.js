const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function loadThemeSync() {
  return import('../renderer/src/theme-sync.js');
}

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeClassList() {
  const values = new Set();
  return {
    toggle(name, enabled) {
      if (enabled) values.add(name);
      else values.delete(name);
    },
    contains(name) {
      return values.has(name);
    }
  };
}

function fakeMedia(matches) {
  const listeners = new Set();
  return {
    matches,
    addEventListener(type, listener) {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'change') listeners.delete(listener);
    },
    setMatches(next) {
      this.matches = next;
      listeners.forEach((listener) => listener({ matches: next }));
    },
    listenerCount() {
      return listeners.size;
    }
  };
}

test('effective theme gives system following deterministic precedence and preserves explicit overrides', async () => {
  const { resolveTheme } = await loadThemeSync();

  assert.equal(resolveTheme({}, false), 'light');
  assert.equal(resolveTheme({}, true), 'dark');
  assert.equal(resolveTheme({ window: { followSystemTheme: true, darkMode: 'dark' } }, false), 'light');
  assert.equal(resolveTheme({ window: { followSystemTheme: true, darkMode: 'light' } }, true), 'dark');
  assert.equal(resolveTheme({ window: { followSystemTheme: false, darkMode: 'dark' } }, false), 'dark');
  assert.equal(resolveTheme({ window: { followSystemTheme: false, darkMode: 'light' } }, true), 'light');
  assert.equal(resolveTheme({ window: { followSystemTheme: false, darkMode: 'system' } }, true), 'dark');
  assert.equal(resolveTheme({ window: { followSystemTheme: false, darkMode: 'invalid' } }, false), 'light');
});

test('theme sync restores persisted mode, follows live settings/system changes, consumes IPC, and cleans up', async () => {
  const { installThemeSync } = await loadThemeSync();
  const media = fakeMedia(false);
  const root = { dataset: {}, style: {}, classList: fakeClassList() };
  const body = { dataset: {}, style: {}, classList: fakeClassList() };
  const ipcHandlers = new Map();
  const unsubscribeCalls = [];
  const applied = [];

  const cleanup = installThemeSync({
    getSettings: async () => ({ window: { followSystemTheme: false, darkMode: 'dark' } }),
    on(channel, handler) {
      ipcHandlers.set(channel, handler);
      return () => {
        unsubscribeCalls.push(channel);
        ipcHandlers.delete(channel);
      };
    },
    mediaQuery: media,
    root,
    body,
    dispatchThemeApplied: (theme) => applied.push(theme)
  });

  assert.equal(media.listenerCount(), 1);
  await flushEvents();
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(body.classList.contains('dark'), true);
  assert.equal(root.style.colorScheme, 'dark');
  assert.deepEqual(applied, ['dark']);

  ipcHandlers.get('settings:loaded')({ window: { followSystemTheme: true, darkMode: 'dark' } });
  assert.equal(root.dataset.theme, 'light');
  assert.equal(body.classList.contains('dark'), false);

  media.setMatches(true);
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(body.classList.contains('dark'), true);

  // Main-process payload is consumed as a synchronization signal, but the
  // persisted policy + current media state remain authoritative.
  ipcHandlers.get('theme:changed')('light');
  assert.equal(root.dataset.theme, 'dark');

  ipcHandlers.get('settings:loaded')({ window: { followSystemTheme: false, darkMode: 'light' } });
  assert.equal(root.dataset.theme, 'light');
  assert.equal(body.dataset.theme, 'light');
  assert.equal(root.classList.contains('dark'), false);

  cleanup();
  assert.equal(media.listenerCount(), 0);
  assert.deepEqual(unsubscribeCalls.sort(), ['settings:loaded', 'theme:changed']);
});

test('App installs theme synchronization once with persisted settings and system media', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/App.jsx'),
    'utf8'
  );

  assert.match(source, /import \{ getSettings, on, send \} from '\.\/api\.js';/);
  assert.match(source, /import \{ installThemeSync \} from '\.\/theme-sync\.js';/);
  assert.match(source, /useEffect\(\(\) => installThemeSync\(\{/);
  assert.match(source, /mediaQuery:\s*window\.matchMedia\('\(prefers-color-scheme: dark\)'\)/);
  assert.match(source, /dispatchThemeApplied:\s*\(theme\) => window\.dispatchEvent/);
});

test('ECharts rebuilds options immediately after the effective theme changes', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/hooks/useECharts.js'),
    'utf8'
  );

  assert.match(source, /tokenmonitor:theme-applied/);
  assert.match(source, /chartRef\.current\.setOption\(buildRef\.current\(\), true\)/);
  assert.match(source, /window\.removeEventListener\('tokenmonitor:theme-applied'/);
});

test('final theme stylesheet is loaded last and covers all main-window surface classes', () => {
  const mainSource = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/main.jsx'),
    'utf8'
  );
  assert.match(
    mainSource,
    /import '\.\/styles\.css';\s*import '\.\/theme\.css';/
  );

  const source = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/theme.css'),
    'utf8'
  );
  assert.match(source, /:root\[data-theme[$]?=['"]dark['"]\]/);
  assert.match(source, /--bg-window:/);
  assert.match(source, /--bg-card:/);
  assert.match(source, /--text-primary:/);
  assert.match(source, /--text-secondary:/);
  assert.match(source, /--border:/);
  assert.match(source, /#app/);
  assert.match(source, /\.component-surface/);
  assert.match(source, /\.titlebar-btn/);
  assert.match(source, /\.statusbar/);
  assert.match(source, /\.content::-webkit-scrollbar-thumb/);
  assert.match(source, /\.heatmap-tooltip/);
});
