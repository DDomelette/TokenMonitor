# Token 消耗速度曲线卡片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个默认关闭、按需启动的 Token 消耗速度曲线卡片，以 10 秒基础点计算 DeepSeek、Codex、Kimi 在八种滚动窗口下的 Token 增量和 Token/分钟。

**Architecture:** 主进程新增纯速度追踪器、按需运行时和 Codex/Kimi 文件变化监听；现有 scheduler 仍负责网络抓取与本地日志增量扫描，并把成功或失败观察结果送入运行时。React 新卡片通过独立 IPC 快照绘制最近 60 个速度点，设置页与卡片共享同一组持久化选项。

**Tech Stack:** Electron 40 主进程 CJS、electron-store、Node `fs.watch`、node:test + assert/strict、React 18、ECharts 5、GridStack 12、Vite 5。

**Spec:** `docs/superpowers/specs/2026-08-09-token-consumption-speed-card-design.md`

## Global Constraints

- 所有开发与提交只在分支 `codex/token-consumption-speed-card` 上进行；不得直接修改或合并 `main`。
- 模块设置键固定为 `components.tokenSpeed`，默认 `false`。
- 统计周期只接受 `10, 20, 30, 60, 180, 300, 3600, 18000` 秒；默认 `30`。
- 展示筛选只接受 `all, deepseek, codex, kimi`；默认 `all`。
- 基础采样间隔固定 `10_000ms`，历史固定 `6h`，每平台最多 `2,160` 点，三平台最多 `6,480` 点。
- 图表固定展示最近 `60` 个基础点，即最近 `10` 分钟；所选周期只改变滚动计算窗口。
- 总 Token 口径包含缓存 Token；不得按具体模型名称拆分。
- 功能关闭时不得保留本功能的额外计时器、文件监听、内存历史或磁盘历史。
- Codex/Kimi 文件监听只加速现有增量扫描；现有 `localLog=60s` 轮询必须保留为兜底。
- 历史同步、数据重建、保留天数变化和同日计数器下降必须 rebaseline，不得形成负数或虚假尖峰。
- UI 文案使用中文；设置页开关必须显示 `Token 消耗速度（会增加内存占用）`。
- 根测试命令为 `npm test`；单文件命令为 `node --test test/<file>.test.js`；renderer 构建命令为 `npm run build:renderer`。
- 每个任务按 TDD 顺序执行并单独提交；不得顺手重构无关模块。

---

## File Map

### New main-process units

- `src/main/core/token-speed-settings.js`：周期/筛选枚举与设置归一化，主进程唯一合法值来源。
- `src/main/core/token-speed-tracker.js`：无 Electron、无计时器、无 I/O 的累计值与滚动速度引擎。
- `src/main/core/local-log-watch-service.js`：Codex/Kimi 根目录监听、防抖、重连状态和关闭清理。
- `src/main/core/token-speed-runtime.js`：模块开关、10 秒采样、每分钟持久化、watcher、scheduler 和 tracker 的编排边界。

### New renderer units

- `renderer/src/lib/token-speed-chart.js`：平台元数据、数值格式和纯 ECharts option 构建。
- `renderer/src/hooks/useTokenSpeed.js`：初始 IPC 快照与 `token-speed:changed` 订阅。
- `renderer/src/components/TokenSpeedCard.jsx`：标题、两个选择器、实时图例、状态文案和曲线容器。

### New tests

- `test/token-speed-settings.test.js`
- `test/token-speed-tracker.test.js`
- `test/local-log-watch-service.test.js`
- `test/token-speed-runtime.test.js`
- `test/token-speed-integration.test.js`
- `test/token-speed-chart.test.js`
- `test/token-speed-card-static.test.js`

---

### Task 1: 设置契约、组件注册与设置页联动

**Files:**
- Create: `src/main/core/token-speed-settings.js`
- Modify: `src/main/store.js:23-47`
- Modify: `src/main/core/settings-write.js:5-13`
- Modify: `src/renderer/js/layout/component-registry.js:138-230`
- Modify: `renderer/src/grid/policy.js:5`
- Modify: `src/renderer/js/settings-definitions.js:29-50`
- Modify: `src/renderer/js/settings-window.js:326-345`
- Modify: `test/component-registry.test.js`
- Create: `test/token-speed-settings.test.js`

**Interfaces:**
- Produces `INTERVAL_SECONDS`, `PROVIDER_FILTERS`, `DEFAULT_TOKEN_SPEED_SETTINGS`.
- Produces `normalizeIntervalSeconds(value)`, `normalizeProviderFilter(value)`, `normalizeTokenSpeedSettings(value)`.
- Produces component id `token-speed`, settings key `components.tokenSpeed`, settings-only label `Token 消耗速度（会增加内存占用）`.
- Persists `data.tokenSpeed.intervalSeconds` and `data.tokenSpeed.providerFilter` through the existing acknowledged settings writer.

- [ ] **Step 1: Write failing settings and registry tests**

Create `test/token-speed-settings.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const registry = require('../src/renderer/js/layout/component-registry.js');

test('token speed settings accept only the eight windows and four filters', () => {
  const settings = require('../src/main/core/token-speed-settings');
  assert.deepEqual(settings.INTERVAL_SECONDS, [10, 20, 30, 60, 180, 300, 3600, 18000]);
  assert.deepEqual(settings.PROVIDER_FILTERS, ['all', 'deepseek', 'codex', 'kimi']);
  assert.equal(settings.normalizeIntervalSeconds('180'), 180);
  assert.equal(settings.normalizeIntervalSeconds(11), 30);
  assert.equal(settings.normalizeProviderFilter('kimi'), 'kimi');
  assert.equal(settings.normalizeProviderFilter('unknown'), 'all');
  assert.deepEqual(settings.normalizeTokenSpeedSettings({
    intervalSeconds: '300', providerFilter: 'codex'
  }), { intervalSeconds: 300, providerFilter: 'codex' });
});

test('token speed is registered as a default-hidden chart with a warning label', () => {
  const component = registry.get('token-speed');
  assert.ok(component);
  assert.equal(component.settingsKey, 'components.tokenSpeed');
  assert.equal(component.defaultVisible, false);
  assert.equal(component.settingsLabel, 'Token 消耗速度（会增加内存占用）');
  assert.equal(component.defaultPlacement.compact.preset, 'full');
  assert.ok(component.presets.compact.some((preset) => preset.name === 'card'));
});

test('settings definitions expose token speed selectors only when enabled', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-definitions.js'), 'utf8'
  );
  const context = { window: { ComponentRegistry: registry } };
  vm.runInNewContext(source, context, { filename: 'settings-definitions.js' });
  const definitions = Array.from(context.window.SettingsDefinitions);
  const toggle = definitions.find((item) => item.key === 'components.tokenSpeed');
  const interval = definitions.find((item) => item.key === 'data.tokenSpeed.intervalSeconds');
  const filter = definitions.find((item) => item.key === 'data.tokenSpeed.providerFilter');
  assert.equal(toggle.label, 'Token 消耗速度（会增加内存占用）');
  assert.deepEqual(Array.from(interval.options, (item) => Number(item.value)), [10, 20, 30, 60, 180, 300, 3600, 18000]);
  assert.equal(interval.visibleWhen.key, 'components.tokenSpeed');
  assert.deepEqual(Array.from(filter.options, (item) => item.value), ['all', 'deepseek', 'codex', 'kimi']);
  assert.equal(filter.visibleWhen.key, 'components.tokenSpeed');
});

test('settings window filters conditional definitions from the live settings snapshot', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-window.js'), 'utf8'
  );
  assert.match(source, /visibleWhen/);
  assert.match(source, /getNested\(settings, d\.visibleWhen\.key\)/);
});
```

Update `test/component-registry.test.js` so automatic settings labels compare against `component.settingsLabel || component.label`, and include `token-speed` in the chart preset assertion.

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test test/token-speed-settings.test.js test/component-registry.test.js`

Expected: FAIL because `token-speed-settings.js` and the `token-speed` registry item do not exist.

- [ ] **Step 3: Implement the settings normalizer**

Create `src/main/core/token-speed-settings.js`:

```js
const INTERVAL_SECONDS = Object.freeze([10, 20, 30, 60, 180, 300, 3600, 18000]);
const PROVIDER_FILTERS = Object.freeze(['all', 'deepseek', 'codex', 'kimi']);
const DEFAULT_TOKEN_SPEED_SETTINGS = Object.freeze({
  intervalSeconds: 30,
  providerFilter: 'all'
});

function normalizeIntervalSeconds(value) {
  const number = Number(value);
  return INTERVAL_SECONDS.includes(number)
    ? number
    : DEFAULT_TOKEN_SPEED_SETTINGS.intervalSeconds;
}

function normalizeProviderFilter(value) {
  return PROVIDER_FILTERS.includes(value)
    ? value
    : DEFAULT_TOKEN_SPEED_SETTINGS.providerFilter;
}

function normalizeTokenSpeedSettings(value) {
  const candidate = value && typeof value === 'object' ? value : {};
  return {
    intervalSeconds: normalizeIntervalSeconds(candidate.intervalSeconds),
    providerFilter: normalizeProviderFilter(candidate.providerFilter)
  };
}

module.exports = {
  INTERVAL_SECONDS,
  PROVIDER_FILTERS,
  DEFAULT_TOKEN_SPEED_SETTINGS,
  normalizeIntervalSeconds,
  normalizeProviderFilter,
  normalizeTokenSpeedSettings
};
```

In `src/main/core/settings-write.js`, normalize the two exact paths before persistence:

```js
const {
  normalizeIntervalSeconds,
  normalizeProviderFilter
} = require('./token-speed-settings');

function normalizeSettingValue(targetKey, value) {
  if (targetKey === 'providers.proxyUrl') return normalizeStoredProxyValue(value);
  if (targetKey === 'data.tokenSpeed.intervalSeconds') return normalizeIntervalSeconds(value);
  if (targetKey === 'data.tokenSpeed.providerFilter') return normalizeProviderFilter(value);
  return value;
}
```

- [ ] **Step 4: Register defaults, layout metadata and conditional setting definitions**

Add these defaults in `src/main/store.js`:

```js
components: {
  tokenSpeed: false
},
data: {
  tokenSpeed: { intervalSeconds: 30, providerFilter: 'all' }
}
```

Keep all existing members and add `'token-speed'` to `componentOrder` immediately before `'token-line'`.

Add this item to the canonical component registry immediately before `token-line`:

```js
{
  id: 'token-speed',
  label: 'Token 消耗速度',
  settingsLabel: 'Token 消耗速度（会增加内存占用）',
  settingsKey: 'components.tokenSpeed',
  defaultVisible: false,
  presets: {
    compact: [
      { name: 'card', w: 4, h: 4 },
      { name: 'half', w: 6, h: 6 },
      { name: 'full', w: 12, h: 7 },
      { name: 'tall', w: 12, h: 9 }
    ],
    wide: [
      { name: 'card', w: 4, h: 4 },
      { name: 'half', w: 6, h: 6 },
      { name: 'full', w: 12, h: 7 },
      { name: 'tall', w: 12, h: 9 }
    ]
  },
  defaultPlacement: {
    compact: { x: 0, y: 30, w: 12, h: 7, preset: 'full' },
    wide: { x: 0, y: 30, w: 12, h: 7, preset: 'full' }
  }
}
```

Move downstream default Y positions to avoid overlap: `token-line=37`, `cost-line=43`, `token-heatmap=49`. Increment layout `VERSION` from `7` to `8`.

Use `settingsLabel` in `componentDefinitions`, then append two conditional data definitions:

```js
var tokenSpeedDefinitions = [
  {
    group: '数据', key: 'data.tokenSpeed.intervalSeconds', type: 'select',
    label: 'Token 速度统计周期', default: 30,
    visibleWhen: { key: 'components.tokenSpeed', equals: true },
    options: [
      { value: 10, label: '10 秒' }, { value: 20, label: '20 秒' },
      { value: 30, label: '30 秒' }, { value: 60, label: '1 分钟' },
      { value: 180, label: '3 分钟' }, { value: 300, label: '5 分钟' },
      { value: 3600, label: '1 小时' }, { value: 18000, label: '5 小时' }
    ]
  },
  {
    group: '数据', key: 'data.tokenSpeed.providerFilter', type: 'select',
    label: 'Token 速度展示平台', default: 'all',
    visibleWhen: { key: 'components.tokenSpeed', equals: true },
    options: [
      { value: 'all', label: '展示全部' },
      { value: 'deepseek', label: 'DeepSeek' },
      { value: 'codex', label: 'Codex' },
      { value: 'kimi', label: 'Kimi' }
    ]
  }
];
```

Insert `tokenSpeedDefinitions` before `tailDefinitions`. In `buildPanel`, exclude a definition when its `visibleWhen` value does not match:

```js
var visibleDefinitions = definitions.filter(function (d) {
  if (!d.visibleWhen) return true;
  return getNested(settings, d.visibleWhen.key) === d.visibleWhen.equals;
});
```

Build groups from `visibleDefinitions` instead of `definitions`.

- [ ] **Step 5: Run targeted tests and the renderer build**

Run: `node --test test/token-speed-settings.test.js test/component-registry.test.js test/layout-policy.test.js test/settings-close-durability.test.js`

Expected: PASS.

Run: `npm run build:renderer`

Expected: Vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/token-speed-settings.js src/main/core/settings-write.js src/main/store.js src/renderer/js/layout/component-registry.js src/renderer/js/settings-definitions.js src/renderer/js/settings-window.js renderer/src/grid/policy.js test/token-speed-settings.test.js test/component-registry.test.js
git commit -m "feat: add optional token speed settings and layout metadata"
```

---

### Task 2: Pure rolling token-speed tracker

**Files:**
- Create: `src/main/core/token-speed-tracker.js`
- Create: `test/token-speed-tracker.test.js`

**Interfaces:**
- Produces constants `SAMPLE_INTERVAL_MS=10000`, `HISTORY_MS=21600000`, `MAX_POINTS_PER_PROVIDER=2160`, `DISPLAY_POINTS=60`, `STORAGE_VERSION=1`, `PROVIDER_IDS`.
- Produces `createTokenSpeedTracker({ now })` with methods `observe`, `rebaseline`, `markUnavailable`, `setDelayed`, `sample`, `getSnapshot`, `serialize`, `hydrate`, `clear`, `getPointCount`.
- `observe({ providerId, dayKey, totalTokens, observedAt })` accepts an authoritative current-day cumulative counter.
- `getSnapshot({ intervalSeconds, providerFilter, at })` returns current metrics plus selected chart series.

- [ ] **Step 1: Write failing tracker tests**

Create `test/token-speed-tracker.test.js` with deterministic timestamps:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTokenSpeedTracker,
  MAX_POINTS_PER_PROVIDER,
  STORAGE_VERSION
} = require('../src/main/core/token-speed-tracker');

function observeAndSample(tracker, providerId, at, total, dayKey = '2026-08-09') {
  tracker.observe({ providerId, dayKey, totalTokens: total, observedAt: at });
  tracker.sample(at);
}

test('30-second window reports delta and normalizes by real elapsed time', () => {
  const tracker = createTokenSpeedTracker({ now: () => 0 });
  observeAndSample(tracker, 'deepseek', 0, 100);
  observeAndSample(tracker, 'deepseek', 10000, 130);
  observeAndSample(tracker, 'deepseek', 20000, 160);
  observeAndSample(tracker, 'deepseek', 35000, 220);
  const snapshot = tracker.getSnapshot({ intervalSeconds: 30, providerFilter: 'deepseek', at: 35000 });
  assert.equal(snapshot.providers[0].deltaTokens, 120);
  assert.equal(snapshot.providers[0].tokensPerMinute, 120 * 60000 / 35000);
  assert.equal(snapshot.providers[0].status, 'ok');
});

test('insufficient coverage stays collecting and never fabricates zero points', () => {
  const tracker = createTokenSpeedTracker({ now: () => 10000 });
  observeAndSample(tracker, 'codex', 0, 10);
  observeAndSample(tracker, 'codex', 10000, 10);
  const snapshot = tracker.getSnapshot({ intervalSeconds: 30, providerFilter: 'codex', at: 10000 });
  assert.equal(snapshot.providers[0].status, 'collecting');
  assert.equal(snapshot.providers[0].tokensPerMinute, null);
  assert.equal(snapshot.series.codex.at(-1).tokensPerMinute, null);
});

test('day rollover adds the new-day counter while same-day rollback only rebaselines', () => {
  const tracker = createTokenSpeedTracker({ now: () => 30000 });
  observeAndSample(tracker, 'kimi', 0, 100, '2026-08-09');
  observeAndSample(tracker, 'kimi', 10000, 150, '2026-08-09');
  observeAndSample(tracker, 'kimi', 20000, 20, '2026-08-10');
  tracker.observe({ providerId: 'kimi', dayKey: '2026-08-10', totalTokens: 5, observedAt: 25000 });
  tracker.sample(30000);
  const state = tracker.serialize(30000).states.kimi;
  assert.equal(state.logicalTotal, 70);
  assert.equal(state.rawTotal, 5);
});

test('unavailable samples form gaps and recovery is marked offline', () => {
  const tracker = createTokenSpeedTracker({ now: () => 40000 });
  observeAndSample(tracker, 'deepseek', 0, 100);
  tracker.markUnavailable('deepseek', { at: 10000, reason: 'network' });
  tracker.sample(10000);
  tracker.sample(20000);
  tracker.observe({ providerId: 'deepseek', dayKey: '2026-08-09', totalTokens: 180, observedAt: 40000 });
  tracker.sample(40000);
  const snapshot = tracker.getSnapshot({ intervalSeconds: 30, providerFilter: 'deepseek', at: 40000 });
  assert.equal(snapshot.providers[0].quality, 'offline');
  assert.equal(snapshot.series.deepseek.at(-2).tokensPerMinute, null);
});

test('history is bounded, serialized and rejects stale payloads', () => {
  const tracker = createTokenSpeedTracker({ now: () => 30000000 });
  tracker.observe({ providerId: 'codex', dayKey: '2026-08-09', totalTokens: 0, observedAt: 0 });
  for (let index = 0; index < MAX_POINTS_PER_PROVIDER + 25; index += 1) {
    tracker.observe({ providerId: 'codex', dayKey: '2026-08-09', totalTokens: index, observedAt: index * 10000 });
    tracker.sample(index * 10000);
  }
  assert.equal(tracker.getPointCount('codex'), MAX_POINTS_PER_PROVIDER);
  const payload = tracker.serialize(21590000);
  assert.equal(payload.version, STORAGE_VERSION);

  const restored = createTokenSpeedTracker({ now: () => 21600000 });
  assert.equal(restored.hydrate(payload, 21600000), true);
  assert.equal(restored.getPointCount('codex'), MAX_POINTS_PER_PROVIDER);
  assert.equal(restored.hydrate(Object.assign({}, payload, { savedAt: 0 }), 30000000), false);
});

test('all filter returns three series while one-provider filters return one', () => {
  const tracker = createTokenSpeedTracker({ now: () => 30000 });
  ['deepseek', 'codex', 'kimi'].forEach((providerId) => {
    observeAndSample(tracker, providerId, 0, 0);
    observeAndSample(tracker, providerId, 30000, 30);
  });
  assert.deepEqual(Object.keys(tracker.getSnapshot({ intervalSeconds: 30, providerFilter: 'all', at: 30000 }).series), ['deepseek', 'codex', 'kimi']);
  assert.deepEqual(Object.keys(tracker.getSnapshot({ intervalSeconds: 30, providerFilter: 'kimi', at: 30000 }).series), ['kimi']);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --test test/token-speed-tracker.test.js`

Expected: FAIL with `Cannot find module '../src/main/core/token-speed-tracker'`.

- [ ] **Step 3: Implement counter observation and bounded sampling**

Create `src/main/core/token-speed-tracker.js` with this public structure and counter rules:

```js
const { normalizeTokenSpeedSettings } = require('./token-speed-settings');

const SAMPLE_INTERVAL_MS = 10000;
const HISTORY_MS = 6 * 60 * 60 * 1000;
const MAX_POINTS_PER_PROVIDER = HISTORY_MS / SAMPLE_INTERVAL_MS;
const DISPLAY_POINTS = 60;
const STORAGE_VERSION = 1;
const PROVIDER_IDS = Object.freeze(['deepseek', 'codex', 'kimi']);

function freshState() {
  return {
    rawDay: null,
    rawTotal: null,
    logicalTotal: 0,
    observed: false,
    sourceStatus: 'collecting',
    delayed: false,
    gapPending: false,
    points: []
  };
}

function normalizeTotal(value) {
  const total = Number(value);
  return Number.isFinite(total) && total >= 0 ? total : 0;
}

function createTokenSpeedTracker(options = {}) {
  const now = options.now || Date.now;
  let states = Object.fromEntries(PROVIDER_IDS.map((id) => [id, freshState()]));

  function requireState(providerId) {
    if (!PROVIDER_IDS.includes(providerId)) throw new RangeError('Unknown token speed provider: ' + providerId);
    return states[providerId];
  }

  function observe(observation) {
    const state = requireState(observation.providerId);
    const total = normalizeTotal(observation.totalTokens);
    const dayKey = String(observation.dayKey || '');
    if (!state.observed) {
      state.rawDay = dayKey;
      state.rawTotal = total;
      state.observed = true;
    } else if (dayKey !== state.rawDay) {
      state.logicalTotal += total;
      state.rawDay = dayKey;
      state.rawTotal = total;
    } else if (total >= state.rawTotal) {
      state.logicalTotal += total - state.rawTotal;
      state.rawTotal = total;
    } else {
      state.rawTotal = total;
      state.gapPending = true;
    }
    if (state.sourceStatus === 'unavailable') state.gapPending = true;
    state.sourceStatus = 'ok';
  }

  function rebaseline(observation) {
    const state = requireState(observation.providerId);
    state.rawDay = String(observation.dayKey || '');
    state.rawTotal = normalizeTotal(observation.totalTokens);
    state.observed = true;
    state.gapPending = true;
    state.sourceStatus = 'ok';
  }

  function sample(at = now()) {
    PROVIDER_IDS.forEach((providerId) => {
      const state = states[providerId];
      state.points.push({
        time: Number(at),
        total: state.logicalTotal,
        valid: state.observed && state.sourceStatus !== 'unavailable',
        gapBefore: state.gapPending,
        delayed: state.delayed
      });
      state.gapPending = false;
      state.points = state.points
        .filter((point) => point.time >= Number(at) - HISTORY_MS)
        .slice(-MAX_POINTS_PER_PROVIDER);
    });
  }

  return {
    observe,
    rebaseline,
    sample,
    markUnavailable(providerId) {
      const state = requireState(providerId);
      state.sourceStatus = 'unavailable';
      state.gapPending = true;
    },
    setDelayed(providerId, delayed) {
      requireState(providerId).delayed = delayed === true;
    },
    getSnapshot,
    serialize,
    hydrate,
    clear() {
      states = Object.fromEntries(PROVIDER_IDS.map((id) => [id, freshState()]));
    },
    getPointCount(providerId) {
      return requireState(providerId).points.length;
    }
  };
}
```

The functions referenced above and defined in the same closure must use these exact rules:

```js
function metricAt(points, currentIndex, windowMs) {
  const current = points[currentIndex];
  if (!current || !current.valid) return { status: 'unavailable', deltaTokens: null, tokensPerMinute: null };
  const target = current.time - windowMs;
  let baselineIndex = -1;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (points[index].valid && points[index].time <= target) {
      baselineIndex = index;
      break;
    }
  }
  if (baselineIndex < 0) {
    const first = points.find((point) => point.valid);
    return {
      status: 'collecting',
      coverageMs: first ? current.time - first.time : 0,
      deltaTokens: null,
      tokensPerMinute: null
    };
  }
  const baseline = points[baselineIndex];
  const elapsedMs = current.time - baseline.time;
  const deltaTokens = Math.max(0, current.total - baseline.total);
  const crossedGap = points.slice(baselineIndex + 1, currentIndex + 1)
    .some((point) => !point.valid || point.gapBefore);
  return {
    status: 'ok',
    quality: crossedGap ? 'offline' : (current.delayed ? 'delayed' : 'fresh'),
    coverageMs: elapsedMs,
    deltaTokens,
    tokensPerMinute: elapsedMs > 0 ? deltaTokens * 60000 / elapsedMs : 0
  };
}
```

`getSnapshot` must normalize its settings, compute metrics for the latest point, compute chart metrics for each of the last 60 point indices using older retained baselines, and include only selected series. `serialize` must return `{ version, savedAt, states }`. `hydrate` must reject invalid version, non-object states, or `savedAt < at - HISTORY_MS`; it must copy only recognized providers and trim points to the 6-hour/2,160-point limits.

- [ ] **Step 4: Run tracker tests**

Run: `node --test test/token-speed-tracker.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/token-speed-tracker.js test/token-speed-tracker.test.js
git commit -m "feat: add bounded rolling token speed tracker"
```

---

### Task 3: Codex/Kimi local-log watch service

**Files:**
- Create: `src/main/core/local-log-watch-service.js`
- Modify: `src/main/providers/codex/index.js`
- Modify: `src/main/providers/kimi/index.js`
- Create: `test/local-log-watch-service.test.js`

**Interfaces:**
- Provider adapters gain optional `localLogRoot(ctx) -> string`.
- Produces `createLocalLogWatchService({ registry, store, onProviderChanged, onStatus, fsImpl, setTimeoutFn, clearTimeoutFn, debounceMs })`.
- Returned service exposes `start()`, `ensure(providerId)`, `stop()`, `getStatus(providerId)`.
- `onStatus(providerId, { delayed, reason })` feeds runtime quality state.

- [ ] **Step 1: Write failing watcher tests**

Create `test/local-log-watch-service.test.js`:

```js
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
```

- [ ] **Step 2: Run the test and verify failure**

Run: `node --test test/local-log-watch-service.test.js`

Expected: FAIL because the watch service module does not exist.

- [ ] **Step 3: Expose provider log roots**

In both local-log provider adapters, import `DEFAULT_ROOT` and add:

```js
localLogRoot(ctx) {
  return (ctx && ctx.store && ctx.store.get('providers.codex.localLogRoot')) || DEFAULT_ROOT();
}
```

Use `providers.kimi.localLogRoot` in the Kimi adapter.

- [ ] **Step 4: Implement the watch service**

Create `src/main/core/local-log-watch-service.js`. Its `ensure` path must:

1. Ignore providers without `capabilities.localLog` or `localLogRoot`.
2. Leave an existing watcher untouched.
3. Resolve the root with `provider.localLogRoot({ store })` and mark `{ delayed: true, reason: 'missing-root' }` when it does not exist.
4. Call `fs.watch(root, { recursive: true }, callback)`.
5. Debounce each provider independently; reset the pending callback on every event.
6. On `error` or unexpected `close`, clear the watcher and mark delayed.
7. On successful watch creation, mark `{ watching: true, delayed: false, reason: null }`.
8. During `stop`, suppress error/close transitions, close watchers and clear timers.

Use this returned shape:

```js
return {
  start() {
    registry.list().forEach((provider) => ensure(provider.id));
  },
  ensure,
  stop,
  getStatus(providerId) {
    const state = states[providerId];
    return state
      ? { watching: !!state.watcher, delayed: !!state.delayed, reason: state.reason || null }
      : { watching: false, delayed: true, reason: 'not-started' };
  }
};
```

- [ ] **Step 5: Run watcher tests and provider tests**

Run: `node --test test/local-log-watch-service.test.js test/providers-codex.test.js test/providers-kimi.test.js test/locallog.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/local-log-watch-service.js src/main/providers/codex/index.js src/main/providers/kimi/index.js test/local-log-watch-service.test.js
git commit -m "feat: watch local token logs while speed module is enabled"
```

---

### Task 4: Optional token-speed runtime and persistence lifecycle

**Files:**
- Create: `src/main/core/token-speed-runtime.js`
- Create: `test/token-speed-runtime.test.js`

**Interfaces:**
- Produces `createTokenSpeedRuntime(options)`.
- Runtime methods: `start()`, `applySettings()`, `observeProvider(providerId, observedAt)`, `markProviderUnavailable(providerId, detail)`, `rebaselineAll(at)`, `getSnapshot()`, `flush()`, `stop()`, `isEnabled()`.
- Internal store key is exactly `tokenSpeedRuntime`; it is never renderer-writable.
- Reads current-day totals from `usageDaily['<provider>:<local-day>'].total`.

- [ ] **Step 1: Write failing lifecycle tests**

Create `test/token-speed-runtime.test.js` with a nested fake store and injectable timers. Cover these exact cases:

```js
test('disabled startup creates no timers, watchers or persisted history', () => {
  const h = runtimeHarness({ components: { tokenSpeed: false } });
  h.runtime.start();
  assert.equal(h.runtime.isEnabled(), false);
  assert.equal(h.intervals.length, 0);
  assert.equal(h.watchStarts, 0);
  assert.equal(h.store.get('tokenSpeedRuntime'), undefined);
});

test('enabling establishes baselines, starts two timers and polls all usage sources', () => {
  const h = runtimeHarness({
    components: { tokenSpeed: false },
    data: { tokenSpeed: { intervalSeconds: 30, providerFilter: 'all' } },
    usageDaily: {
      'deepseek:2026-08-09': { total: 100 },
      'codex:2026-08-09': { total: 200 },
      'kimi:2026-08-09': { total: 300 }
    }
  });
  h.runtime.start();
  h.store.set('components.tokenSpeed', true);
  h.runtime.applySettings();
  assert.equal(h.runtime.isEnabled(), true);
  assert.equal(h.intervals.length, 2);
  assert.equal(h.watchStarts, 1);
  assert.deepEqual(h.polls, [
    ['deepseek', 'usage'], ['codex', 'localLog'], ['kimi', 'localLog']
  ]);
  assert.equal(h.runtime.getSnapshot().providers[0].status, 'collecting');
});

test('selection changes keep history while disabling stops and deletes it', () => {
  const h = runtimeHarness({
    components: { tokenSpeed: true },
    data: { tokenSpeed: { intervalSeconds: 30, providerFilter: 'all' } }
  });
  h.runtime.start();
  h.store.set('data.tokenSpeed.intervalSeconds', 300);
  h.runtime.applySettings();
  assert.equal(h.runtime.getSnapshot().intervalSeconds, 300);
  h.store.set('components.tokenSpeed', false);
  h.runtime.applySettings();
  assert.equal(h.runtime.isEnabled(), false);
  assert.equal(h.watchStops, 1);
  assert.equal(h.store.get('tokenSpeedRuntime'), undefined);
});

test('flush persists at most six hours and startup restores a valid payload', () => {
  const first = runtimeHarness({
    components: { tokenSpeed: true },
    data: { tokenSpeed: { intervalSeconds: 30, providerFilter: 'all' } }
  });
  first.runtime.start();
  first.runtime.flush();
  const payload = first.store.get('tokenSpeedRuntime');
  assert.equal(payload.version, 1);
  const second = runtimeHarness({
    components: { tokenSpeed: true },
    data: { tokenSpeed: { intervalSeconds: 30, providerFilter: 'all' } },
    tokenSpeedRuntime: payload
  });
  second.runtime.start();
  assert.equal(second.runtime.isEnabled(), true);
});

test('rebaseline updates raw counters without creating a speed spike', () => {
  const h = runtimeHarness({
    components: { tokenSpeed: true },
    data: { tokenSpeed: { intervalSeconds: 30, providerFilter: 'deepseek' } },
    usageDaily: { 'deepseek:2026-08-09': { total: 100 } }
  });
  h.runtime.start();
  h.store.set('usageDaily.deepseek:2026-08-09', { total: 100000 });
  h.runtime.rebaselineAll();
  assert.notEqual(h.runtime.getSnapshot().providers[0].deltaTokens, 99900);
});
```

The helper must expose fake `setIntervalFn`, `clearIntervalFn`, watcher factory, scheduler poll calls, broadcast calls and store. Use a fixed local date of `2026-08-09` via `now()`.

- [ ] **Step 2: Run the test and verify failure**

Run: `node --test test/token-speed-runtime.test.js`

Expected: FAIL because `token-speed-runtime.js` does not exist.

- [ ] **Step 3: Implement runtime lifecycle**

Create `src/main/core/token-speed-runtime.js` with these constants and helpers:

```js
const { localDayStr } = require('./locallog');
const { normalizeTokenSpeedSettings } = require('./token-speed-settings');
const { createTokenSpeedTracker, PROVIDER_IDS, SAMPLE_INTERVAL_MS } = require('./token-speed-tracker');
const { createLocalLogWatchService } = require('./local-log-watch-service');

const PERSIST_INTERVAL_MS = 60000;
const STORAGE_KEY = 'tokenSpeedRuntime';

function readObservation(store, providerId, at) {
  const dayKey = localDayStr(at);
  const daily = store.get('usageDaily') || {};
  const row = daily[providerId + ':' + dayKey];
  return {
    providerId,
    dayKey,
    totalTokens: Number(row && row.total) || 0,
    observedAt: at
  };
}
```

`createTokenSpeedRuntime` must inject `now`, interval functions, tracker factory and watcher factory for tests. Implement transitions with these rules:

Construct the watch service once and wire it to the existing scheduler and tracker quality state:

```js
const watchService = watchServiceFactory({
  registry,
  store,
  onProviderChanged(providerId) {
    scheduler.poll(providerId, 'localLog');
  },
  onStatus(providerId, status) {
    tracker.setDelayed(providerId, status.delayed === true);
    if (enabled) broadcastSnapshot();
  }
});
```

```js
function applySettings() {
  const shouldEnable = store.get('components.tokenSpeed') === true;
  settings = normalizeTokenSpeedSettings(store.get('data.tokenSpeed'));
  if (shouldEnable && !enabled) enable();
  else if (!shouldEnable && enabled) disable();
  else if (enabled) broadcastSnapshot();
}

function enable() {
  enabled = true;
  const at = now();
  const hydrated = tracker.hydrate(store.get(STORAGE_KEY), at);
  PROVIDER_IDS.forEach((providerId) => {
    const observation = readObservation(store, providerId, at);
    if (hydrated) tracker.observe(observation);
    else tracker.rebaseline(observation);
  });
  tracker.sample(at);
  watchService.start();
  sampleTimer = setIntervalFn(sampleOnce, SAMPLE_INTERVAL_MS);
  persistTimer = setIntervalFn(flush, PERSIST_INTERVAL_MS);
  scheduler.poll('deepseek', 'usage');
  scheduler.poll('codex', 'localLog');
  scheduler.poll('kimi', 'localLog');
  broadcastSnapshot();
}

function disable() {
  stopTimers();
  watchService.stop();
  tracker.clear();
  store.delete(STORAGE_KEY);
  enabled = false;
  broadcastSnapshot();
}
```

`observeProvider` reads the current store row, calls `tracker.observe`, calls `watchService.ensure(providerId)` for local-log providers, and broadcasts only after the next sample unless availability changed. `sampleOnce` samples and broadcasts. `flush` writes only while enabled. `stop` flushes, stops timers and watcher but preserves history for restart. `rebaselineAll` calls `tracker.rebaseline(readObservation(...))` for all providers and samples a gap point. `getSnapshot` returns `{ enabled: false, intervalSeconds, providerFilter, providers: [], series: {} }` when disabled; otherwise delegates to the tracker.

- [ ] **Step 4: Run runtime tests**

Run: `node --test test/token-speed-runtime.test.js test/token-speed-tracker.test.js test/local-log-watch-service.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/token-speed-runtime.js test/token-speed-runtime.test.js
git commit -m "feat: add optional token speed runtime lifecycle"
```

---

### Task 5: Scheduler, app lifecycle, IPC and rebaseline integration

**Files:**
- Modify: `src/main/core/scheduler.js:17-219`
- Modify: `src/main/index.js:29-42,456-470,569-658`
- Modify: `src/main/ipc.js:29-225`
- Modify: `src/preload/preload.js:5-59`
- Create: `test/token-speed-integration.test.js`
- Modify: `test/scheduler.test.js`

**Interfaces:**
- Scheduler accepts optional callbacks `onUsageObservation(providerId, detail)` and `onUsageUnavailable(providerId, detail)`.
- Produces invoke channel `get:token-speed` and event channel `token-speed:changed`.
- `deps.tokenSpeedRuntime` is injected into `setupIPC`.
- History sync and `data.historyDays` changes call `rebaselineAll` after store mutation.

- [ ] **Step 1: Write failing scheduler callback tests**

Append to `test/scheduler.test.js`:

```js
test('scheduler reports successful web usage and local-log observations', async () => {
  const observations = [];
  const web = makeFakeAdapter({
    id: 'web',
    capabilities: { balance: false, webUsage: true, quota: false, localLog: false, realtimeProxy: false },
    fetchUsage: async () => ({ amount: { aggregate: { todayTokens: 10 } } })
  });
  const local = makeFakeAdapter({
    id: 'local',
    capabilities: { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false },
    readLocalLog: async () => []
  });
  const scheduler = startScheduler({
    registry: makeRegistry([web, local]),
    store: makeFakeStore({}),
    broadcast() {},
    intervals: false,
    onUsageObservation(providerId, detail) { observations.push([providerId, detail.channel]); }
  });
  await scheduler.poll('web', 'usage');
  await scheduler.poll('local', 'localLog');
  assert.deepEqual(observations, [['web', 'usage'], ['local', 'localLog']]);
  scheduler.stop();
});

test('scheduler reports usage-source failures without exposing raw errors', async () => {
  const unavailable = [];
  const web = makeFakeAdapter({
    capabilities: { balance: false, webUsage: true, quota: false, localLog: false, realtimeProxy: false },
    fetchUsage: async () => { throw new Error('secret upstream body'); }
  });
  const scheduler = startScheduler({
    registry: makeRegistry([web]), store: makeFakeStore({}), broadcast() {}, intervals: false,
    onUsageUnavailable(providerId, detail) { unavailable.push([providerId, detail.channel]); }
  });
  await scheduler.poll('fake', 'usage');
  assert.deepEqual(unavailable, [['fake', 'usage']]);
  scheduler.stop();
});
```

- [ ] **Step 2: Write failing IPC and lifecycle source assertions**

Create `test/token-speed-integration.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ipc = fs.readFileSync(path.join(root, 'src/main/ipc.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');

test('token speed has a dedicated invoke snapshot and event channel', () => {
  assert.match(ipc, /handle\('get:token-speed'/);
  assert.match(preload, /'get:token-speed'/);
  assert.match(preload, /'token-speed:changed'/);
});

test('main process owns one runtime and stops it before quitting', () => {
  assert.match(index, /createTokenSpeedRuntime/);
  assert.match(index, /tokenSpeedRuntime\.start\(\)/);
  assert.match(index, /tokenSpeedRuntime\.stop\(\)/);
  assert.match(index, /onUsageObservation/);
  assert.match(index, /onUsageUnavailable/);
});

test('history sync, history retention and settings reset rebaseline or disable runtime', () => {
  assert.match(ipc, /sync:history[\s\S]*?tokenSpeedRuntime\.rebaselineAll/);
  assert.match(index, /data\.historyDays[\s\S]*?rebaselineAll/);
  assert.match(ipc, /settings:reset[\s\S]*?tokenSpeedRuntime\.applySettings/);
});
```

- [ ] **Step 3: Run tests and verify failure**

Run: `node --test test/scheduler.test.js test/token-speed-integration.test.js`

Expected: FAIL because callbacks and IPC channels are absent.

- [ ] **Step 4: Add scheduler observation callbacks**

Extend `startScheduler` parameters and add safe helpers:

```js
function notifyUsageObservation(provider, channel) {
  if (typeof onUsageObservation === 'function') {
    onUsageObservation(provider.id, { channel, observedAt: Date.now() });
  }
}

function notifyUsageUnavailable(provider, channel) {
  if (typeof onUsageUnavailable === 'function') {
    onUsageUnavailable(provider.id, { channel, observedAt: Date.now() });
  }
}
```

Call `notifyUsageObservation(provider, 'usage')` only after successful `fetchUsage` persistence and `notifyUsageObservation(provider, 'localLog')` after every successful local scan, including an empty scan. Call the unavailable callback in both catch blocks and when protected web usage cannot poll because credentials are missing. Do not pass raw Error objects to these callbacks.

- [ ] **Step 5: Wire the runtime into index.js**

Add `let tokenSpeedRuntime = null`, import `createTokenSpeedRuntime`, and pass closure callbacks to scheduler:

```js
onUsageObservation: (providerId, detail) => {
  if (tokenSpeedRuntime) tokenSpeedRuntime.observeProvider(providerId, detail.observedAt);
},
onUsageUnavailable: (providerId, detail) => {
  if (tokenSpeedRuntime) tokenSpeedRuntime.markProviderUnavailable(providerId, detail);
}
```

After scheduler creation and provider registration, construct and start exactly one runtime:

```js
tokenSpeedRuntime = createTokenSpeedRuntime({
  store,
  registry,
  scheduler,
  broadcast: (channel, payload) => broadcastToWindows(channel, payload)
});
tokenSpeedRuntime.start();
```

Extend `applySetting`:

```js
case 'components.tokenSpeed':
case 'data.tokenSpeed.intervalSeconds':
case 'data.tokenSpeed.providerFilter':
  if (tokenSpeedRuntime) tokenSpeedRuntime.applySettings();
  break;
case 'data.historyDays':
  if (tokenSpeedRuntime) tokenSpeedRuntime.rebaselineAll();
  break;
```

Inject `tokenSpeedRuntime` into `setupIPC`. In `before-quit`, call `tokenSpeedRuntime.stop()` before `scheduler.stop()`.

- [ ] **Step 6: Add IPC, reset and history-sync behavior**

In `src/main/ipc.js`:

```js
ipcMain.handle('get:token-speed', () => deps.tokenSpeedRuntime.getSnapshot());
```

After all history-sync writes and before `scheduler.pollAll()`, call `deps.tokenSpeedRuntime.rebaselineAll()`. After `resetSettingsStore`, call `deps.tokenSpeedRuntime.applySettings()` so the default-off reset stops and clears the module. The internal `tokenSpeedRuntime` key must not be added to `RESET_KEEP_KEYS`.

Add `'token-speed:changed'` to preload `on` and `'get:token-speed'` to preload `invoke`.

- [ ] **Step 7: Run backend integration tests**

Run: `node --test test/scheduler.test.js test/scheduler-locallog-broadcast.test.js test/token-speed-integration.test.js test/token-speed-runtime.test.js test/settings-reset-external-effects.test.js test/history-sync-ipc.test.js`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/core/scheduler.js src/main/index.js src/main/ipc.js src/preload/preload.js test/scheduler.test.js test/token-speed-integration.test.js
git commit -m "feat: wire token speed runtime through scheduler and IPC"
```

---

### Task 6: Pure chart option, IPC hook and curve card component

**Files:**
- Create: `renderer/src/lib/token-speed-chart.js`
- Create: `renderer/src/hooks/useTokenSpeed.js`
- Create: `renderer/src/components/TokenSpeedCard.jsx`
- Modify: `renderer/src/api.js`
- Create: `test/token-speed-chart.test.js`
- Create: `test/token-speed-card-static.test.js`

**Interfaces:**
- Produces `PROVIDER_META`, `INTERVAL_OPTIONS`, `FILTER_OPTIONS`, `formatTokenRate`, `visibleProviderIds`, `buildTokenSpeedOption`.
- `useTokenSpeed()` returns the latest `get:token-speed`/`token-speed:changed` snapshot.
- `TokenSpeedCard` writes only the two exact settings keys through acknowledged `settings:save`.

- [ ] **Step 1: Write failing pure chart tests**

Create `test/token-speed-chart.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('all mode creates three smooth non-connecting platform curves', async () => {
  const chart = await import('../renderer/src/lib/token-speed-chart.js');
  const snapshot = {
    providerFilter: 'all',
    series: {
      deepseek: [{ time: 1, tokensPerMinute: 100, deltaTokens: 20, quality: 'fresh' }],
      codex: [{ time: 1, tokensPerMinute: 50, deltaTokens: 10, quality: 'offline' }],
      kimi: [{ time: 1, tokensPerMinute: null, deltaTokens: null, quality: 'collecting' }]
    }
  };
  const option = chart.buildTokenSpeedOption(snapshot, { isDark: true, compact: false });
  assert.deepEqual(option.series.map((item) => item.name), ['DeepSeek', 'Codex', 'Kimi']);
  assert.deepEqual(option.series.map((item) => item.lineStyle.color), ['#6E94F5', '#F2A05C', '#4ECB94']);
  assert.ok(option.series.every((item) => item.smooth === true && item.connectNulls === false));
  assert.equal(option.series[2].data[0].value[1], null);
});

test('single-provider mode creates one stronger area curve', async () => {
  const chart = await import('../renderer/src/lib/token-speed-chart.js');
  const snapshot = {
    providerFilter: 'codex',
    series: { codex: [{ time: 1, tokensPerMinute: 1200, deltaTokens: 600, quality: 'fresh' }] }
  };
  const option = chart.buildTokenSpeedOption(snapshot, { isDark: false, compact: false });
  assert.equal(option.series.length, 1);
  assert.equal(option.series[0].name, 'Codex');
  assert.ok(option.series[0].areaStyle.opacity > 0.1);
  assert.equal(chart.formatTokenRate(24600), '24.6K/min');
});
```

- [ ] **Step 2: Write failing component source assertions**

Create `test/token-speed-card-static.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const component = fs.readFileSync(path.join(root, 'renderer/src/components/TokenSpeedCard.jsx'), 'utf8');
const hook = fs.readFileSync(path.join(root, 'renderer/src/hooks/useTokenSpeed.js'), 'utf8');
const api = fs.readFileSync(path.join(root, 'renderer/src/api.js'), 'utf8');

test('card exposes both selectors and the live curve surface', () => {
  assert.match(component, /Token 消耗速度/);
  assert.match(component, /data\.tokenSpeed\.providerFilter/);
  assert.match(component, /data\.tokenSpeed\.intervalSeconds/);
  assert.match(component, /token-speed-chart/);
  assert.match(component, /采集中/);
  assert.match(component, /含离线时间/);
});

test('hook loads and subscribes to the dedicated speed snapshot', () => {
  assert.match(hook, /getTokenSpeed/);
  assert.match(hook, /onTokenSpeedChanged/);
  assert.match(api, /get:token-speed/);
  assert.match(api, /token-speed:changed/);
});
```

- [ ] **Step 3: Run tests and verify failure**

Run: `node --test test/token-speed-chart.test.js test/token-speed-card-static.test.js`

Expected: FAIL because the renderer files do not exist.

- [ ] **Step 4: Implement the pure option builder**

Create `renderer/src/lib/token-speed-chart.js` with exact provider metadata:

```js
export const PROVIDER_META = Object.freeze({
  deepseek: { label: 'DeepSeek', color: '#6E94F5' },
  codex: { label: 'Codex', color: '#F2A05C' },
  kimi: { label: 'Kimi', color: '#4ECB94' }
});

export const INTERVAL_OPTIONS = Object.freeze([
  [10, '10 秒'], [20, '20 秒'], [30, '30 秒'], [60, '1 分钟'],
  [180, '3 分钟'], [300, '5 分钟'], [3600, '1 小时'], [18000, '5 小时']
]);

export const FILTER_OPTIONS = Object.freeze([
  ['all', '展示全部'], ['deepseek', 'DeepSeek'], ['codex', 'Codex'], ['kimi', 'Kimi']
]);

export function formatTokenRate(value) {
  const number = Number(value) || 0;
  if (number >= 1000000) return (number / 1000000).toFixed(1) + 'M/min';
  if (number >= 1000) return (number / 1000).toFixed(1) + 'K/min';
  return Math.round(number).toLocaleString('zh-CN') + '/min';
}

export function visibleProviderIds(filter) {
  return filter === 'all' ? ['deepseek', 'codex', 'kimi'] : [filter];
}
```

`buildTokenSpeedOption(snapshot, { isDark, compact })` must return hidden time/value axes, `animation: false`, an axis tooltip, `connectNulls: false`, `smooth: true`, `showSymbol: false`, and one data object per point:

```js
{
  value: [point.time, point.tokensPerMinute],
  deltaTokens: point.deltaTokens,
  quality: point.quality
}
```

Use an ECharts plain linear-gradient object for `areaStyle.color`; use opacity `0.16` for a single series and `0.05` for multiple series. Tooltip rows must include time, platform, `本周期 +X Token`, formatted speed and quality labels.

- [ ] **Step 5: Implement API hook and component**

Add API wrappers:

```js
export function getTokenSpeed() {
  return api.invoke('get:token-speed');
}

export function onTokenSpeedChanged(cb) {
  return api.on('token-speed:changed', cb);
}

export function saveSetting(key, value) {
  return api.invoke('settings:save', { key, value });
}
```

`useTokenSpeed` must load once, subscribe once, and clean up the listener:

```js
export default function useTokenSpeed() {
  const [snapshot, setSnapshot] = useState(null);
  useEffect(() => {
    let active = true;
    getTokenSpeed().then((value) => { if (active) setSnapshot(value); }).catch(() => {});
    const unsubscribe = onTokenSpeedChanged((value) => setSnapshot(value));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return snapshot;
}
```

`TokenSpeedCard.jsx` must:

- Render an inline SVG speedometer icon and title.
- Render native accessible selects using `FILTER_OPTIONS` and `INTERVAL_OPTIONS`.
- Persist only `data.tokenSpeed.providerFilter` and `data.tokenSpeed.intervalSeconds`.
- Render visible provider legends with colored dots and `formatTokenRate`.
- In single mode append `本周期 +<delta> Token`.
- Show `采集中：<covered>/<window>` when current metrics are collecting.
- Show `数据暂不可用`, `含离线时间`, or `更新可能延迟` for corresponding qualities.
- Use `useECharts` with `buildTokenSpeedOption` and a `token-speed-chart` container.

- [ ] **Step 6: Run renderer unit/static tests and build**

Run: `node --test test/token-speed-chart.test.js test/token-speed-card-static.test.js`

Expected: PASS.

Run: `npm run build:renderer`

Expected: Vite build succeeds.

- [ ] **Step 7: Commit**

```bash
git add renderer/src/api.js renderer/src/lib/token-speed-chart.js renderer/src/hooks/useTokenSpeed.js renderer/src/components/TokenSpeedCard.jsx test/token-speed-chart.test.js test/token-speed-card-static.test.js
git commit -m "feat: add token speed curve card"
```

---

### Task 7: Dashboard/GridStack integration and responsive styling

**Files:**
- Modify: `renderer/src/components/Dashboard.jsx:17-80`
- Modify: `renderer/src/styles.css:245-323`
- Modify: `test/token-speed-card-static.test.js`

**Interfaces:**
- `WidgetBody('token-speed')` renders `TokenSpeedCard`.
- `token-speed` is both an embedded self-titled widget and a chart widget.
- Minimum grid size is `{ w: 4, h: 4 }`.

- [ ] **Step 1: Add failing dashboard and style assertions**

Append to `test/token-speed-card-static.test.js`:

```js
test('Dashboard routes token-speed as an embedded chart widget', () => {
  const dashboard = fs.readFileSync(path.join(root, 'renderer/src/components/Dashboard.jsx'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'renderer/src/styles.css'), 'utf8');
  assert.match(dashboard, /import TokenSpeedCard/);
  assert.match(dashboard, /id === 'token-speed'/);
  assert.match(dashboard, /CHART_IDS[\s\S]*?'token-speed'/);
  assert.match(dashboard, /EMBED_IDS[\s\S]*?'token-speed'/);
  assert.match(styles, /\.token-speed-card/);
  assert.match(styles, /\.token-speed-controls/);
  assert.match(styles, /\.token-speed-legend/);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `node --test test/token-speed-card-static.test.js`

Expected: FAIL because Dashboard does not route the card and styles are absent.

- [ ] **Step 3: Route the widget through Dashboard**

Import `TokenSpeedCard`, add `token-speed` to `EMBED_IDS` and `CHART_IDS`, set its minimum to `{ w: 4, h: 4 }`, and add this branch before the generic `ChartWidget` fallback:

```jsx
if (id === 'token-speed') {
  return <TokenSpeedCard />;
}
```

Because it is embedded, Dashboard must not render the outer `.component-title`; the component owns its title and controls.

- [ ] **Step 4: Add scoped responsive styles**

Add styles that preserve the existing card surface and use container queries:

```css
.token-speed-card {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 6px;
}

.token-speed-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.token-speed-heading {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 650;
}

.token-speed-controls {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.token-speed-select {
  max-width: 112px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font: inherit;
  font-size: 10px;
  padding: 3px 20px 3px 6px;
}

.token-speed-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 12px;
  color: var(--text-secondary);
  font-size: 10px;
}

.token-speed-chart {
  flex: 1;
  min-height: 54px;
  width: 100%;
}

@container (max-width: 220px) {
  .token-speed-controls { width: 100%; margin-left: 0; }
  .token-speed-select { flex: 1; min-width: 0; }
  .token-speed-legend { gap: 3px 8px; font-size: 9px; }
}
```

Use existing CSS variables only; do not introduce a new theme palette.

- [ ] **Step 5: Run layout tests and build**

Run: `node --test test/token-speed-card-static.test.js test/component-registry.test.js test/component-visibility.test.js test/layout-policy.test.js`

Expected: PASS.

Run: `npm run build:renderer`

Expected: Vite build succeeds.

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/Dashboard.jsx renderer/src/styles.css test/token-speed-card-static.test.js
git commit -m "feat: integrate token speed card into dashboard layout"
```

---

### Task 8: Documentation, full regression and visual acceptance

**Files:**
- Modify: `README.md`
- Modify: `使用说明.md`

**Interfaces:**
- Documents that the module is default-off, increases memory usage, starts counting only when enabled, and clears its six-hour history when disabled.
- Does not push, merge, or open a PR without a separate user request.

- [ ] **Step 1: Update user-facing documentation**

Add a concise “Token 消耗速度” section to both files containing these exact facts:

```text
- 在设置 → 组件中开启“Token 消耗速度（会增加内存占用）”。
- 支持展示全部、DeepSeek、Codex、Kimi，以及 10 秒到 5 小时的八种滚动窗口。
- 曲线显示标准化后的 Token/分钟，悬停可查看本周期增量。
- 模块只在开启后开始计数；关闭会停止额外监听并清除最近 6 小时速度历史。
```

- [ ] **Step 2: Run every targeted feature test**

Run:

```powershell
node --test test/token-speed-settings.test.js test/token-speed-tracker.test.js test/local-log-watch-service.test.js test/token-speed-runtime.test.js test/token-speed-integration.test.js test/token-speed-chart.test.js test/token-speed-card-static.test.js
```

Expected: all feature tests PASS, 0 failures.

- [ ] **Step 3: Run the complete regression suite**

Run: `npm test`

Expected: all tests PASS; the baseline was 419 tests, 413 pass, 6 skip, 0 fail, so the total must be higher with 0 failures.

- [ ] **Step 4: Build the production renderer**

Run: `npm run build:renderer`

Expected: Vite build succeeds. The existing bundle-size warning is acceptable; no new build error is acceptable.

- [ ] **Step 5: Perform visual acceptance without changing main**

Run: `npm start`

Verify in the Electron app:

1. Settings initially shows `Token 消耗速度（会增加内存占用）` off; its period/filter rows are hidden.
2. Enabling it reveals both rows and adds a horizontal speed card to the dashboard.
3. The card shows a speedometer icon, two selectors, three colored legends in `展示全部`, and a smooth dark/light-compatible curve area.
4. Selecting one provider leaves one curve and adds `本周期 +X Token`.
5. A newly enabled 30-second window shows collection progress instead of zero-filled history.
6. Disabling the component removes the card; re-enabling starts collection from a fresh baseline.
7. Card, half, full and tall GridStack presets remain readable and draggable when layout is unlocked.

Capture one dark-theme and one light-theme screenshot for local QA if the environment permits; do not commit user-specific screenshots or credentials.

- [ ] **Step 6: Check scope and worktree state**

Run:

```powershell
git status --short
git diff --check
git log --oneline --decorate -10
```

Expected: only intended documentation changes remain before the final commit; no generated `renderer/dist`, credentials, user data, or screenshots are tracked.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md 使用说明.md
git commit -m "docs: explain optional token speed monitoring"
```

- [ ] **Step 8: Final branch verification**

Run:

```powershell
git status --short --branch
git branch --show-current
```

Expected: clean worktree on `codex/token-consumption-speed-card`. Stop here and report results; do not merge into `main`.

---

## Final Acceptance Checklist

- [ ] Module is default-off and carries the memory warning in settings.
- [ ] Disabled mode has no extra speed timer, watcher, in-memory history or persisted history.
- [ ] Enabling establishes a fresh baseline; prior same-day totals are not counted.
- [ ] All eight rolling windows compute with actual elapsed time.
- [ ] All/DeepSeek/Codex/Kimi filters update the curve without clearing history.
- [ ] DeepSeek uses existing 10-second usage polling.
- [ ] Codex/Kimi use debounced file events with existing 60-second scans as fallback.
- [ ] Six-hour history is bounded to 2,160 points/provider and survives valid restarts.
- [ ] Closing the module clears memory and `tokenSpeedRuntime` storage.
- [ ] Cross-day resets, same-day rollback, history sync and retention changes never create spikes.
- [ ] Offline or unavailable sources create gaps rather than zero-filled data.
- [ ] Curves use DeepSeek blue, Codex orange and Kimi green, with no complex visible axes.
- [ ] Settings page and in-card selectors stay synchronized.
- [ ] Complete tests and renderer build pass on the feature branch.
- [ ] No merge, push or PR is performed without explicit user authorization.
