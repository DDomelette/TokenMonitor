# Component Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `components.*` setting immediately control whether its registered dashboard module is rendered, without deleting saved layout geometry.

**Architecture:** Add a pure registry-driven visibility module under `renderer/src/grid/`, cover it with Node tests, then make `Dashboard` retain and subscribe to the latest settings snapshot. A visibility signature will reuse the dashboard’s existing GridStack rebuild mechanism; the persisted layout remains complete and unchanged.

**Tech Stack:** Electron, React 18, Vite 5, GridStack 12, Node.js test runner.

## Global Constraints

- Only modify `DDomelette/TokenMonitor`.
- Scope is Issue #2 only.
- Use TDD: observe the regression test fail before writing production code.
- Preserve all layout records when modules are hidden.
- Do not merge the PR.
- Create a Draft PR only after fresh test and build evidence is available; otherwise keep validation limitations explicit.

---

### Task 1: Add registry-driven visibility policy

**Files:**
- Create: `renderer/src/grid/visibility.js`
- Create: `test/component-visibility.test.js`

**Interfaces:**
- Consumes: `registry.list()` from `renderer/src/grid/components.js`; settings objects shaped like `{ components: { tokenLine: false } }`.
- Produces:
  - `getNestedSetting(settings, path): unknown`
  - `isComponentVisible(component, settings): boolean`
  - `visibleComponentIds(settings): string[]`

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadVisibility() {
  return import('../renderer/src/grid/visibility.js');
}

test('disabled registered components are excluded without mutating layout records', async () => {
  const { visibleComponentIds } = await loadVisibility();
  const layout = {
    items: [
      { id: 'token-line', x: 0, y: 30, w: 12, h: 6 },
      { id: 'cost-line', x: 0, y: 36, w: 12, h: 6 }
    ]
  };
  const before = JSON.parse(JSON.stringify(layout));

  const visible = visibleComponentIds({
    components: { tokenLine: false, costLine: true }
  });

  assert.equal(visible.includes('token-line'), false);
  assert.equal(visible.includes('cost-line'), true);
  assert.deepEqual(layout, before);
});

test('missing component settings use registry defaults and false remains false', async () => {
  const { visibleComponentIds } = await loadVisibility();

  const defaults = visibleComponentIds({});
  assert.equal(defaults.includes('token-line'), true);

  const disabled = visibleComponentIds({ components: { costLine: false } });
  assert.equal(disabled.includes('cost-line'), false);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/component-visibility.test.js
```

Expected: FAIL because `renderer/src/grid/visibility.js` does not exist.

- [ ] **Step 3: Implement the minimal visibility policy**

```js
import * as registry from './components.js';

export function getNestedSetting(settings, path) {
  if (!settings || typeof path !== 'string') return undefined;
  return path.split('.').reduce((value, key) => {
    if (value === null || value === undefined) return undefined;
    return value[key];
  }, settings);
}

export function isComponentVisible(component, settings) {
  if (!component) return false;
  const configured = getNestedSetting(settings, component.settingsKey);
  return configured === undefined ? component.defaultVisible !== false : configured !== false;
}

export function visibleComponentIds(settings) {
  return registry.list()
    .filter((component) => isComponentVisible(component, settings))
    .map((component) => component.id);
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test test/component-visibility.test.js
```

Expected: PASS with 2 tests and 0 failures.

- [ ] **Step 5: Commit**

```bash
git add renderer/src/grid/visibility.js test/component-visibility.test.js
git commit -m "test: cover component visibility settings"
```

---

### Task 2: Connect live settings to Dashboard rendering

**Files:**
- Modify: `renderer/src/components/Dashboard.jsx`
- Modify: `test/component-visibility.test.js`

**Interfaces:**
- Consumes: `getSettings()`, `on('settings:loaded', cb)`, `visibleComponentIds(settings)`.
- Produces: visible GridStack children and a visibility signature that rebuilds the grid when component settings change.

- [ ] **Step 1: Extend the regression test with integration guards**

Add source assertions that require Dashboard to:

```js
const fs = require('node:fs');
const path = require('node:path');

const dashboardSource = fs.readFileSync(
  path.resolve(__dirname, '../renderer/src/components/Dashboard.jsx'),
  'utf8'
);

assert.match(dashboardSource, /visibleComponentIds/);
assert.match(dashboardSource, /settings:loaded/);
assert.match(dashboardSource, /visibleIds\.has\(item\.id\)/);
```

Use a named test: `Dashboard subscribes to settings and filters GridStack nodes by visible IDs`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test test/component-visibility.test.js
```

Expected: FAIL because Dashboard does not yet import the helper, subscribe to `settings:loaded`, or filter by visible IDs.

- [ ] **Step 3: Implement the minimal Dashboard integration**

Make these focused changes:

```js
import { getSettings, on, send } from '../api.js';
import { visibleComponentIds } from '../grid/visibility.js';
```

Add settings state and a stable visibility signature:

```js
const [settings, setSettings] = useState(null);
const visibleIds = useMemo(
  () => new Set(visibleComponentIds(settings || {})),
  [settings]
);
const visibilitySignature = Array.from(visibleIds).sort().join(',');
const visibilitySignatureRef = useRef(visibilitySignature);
```

During initial settings load, save both the validated layout and settings snapshot:

```js
getSettings().then((nextSettings) => {
  layoutRef.current = validateState(nextSettings.layout, nextSettings);
  setSettings(nextSettings);
  setReady(true);
}).catch(() => {});
```

Subscribe once to live settings:

```js
useEffect(() => on('settings:loaded', (nextSettings) => {
  setSettings(nextSettings || {});
}), []);
```

Rebuild only when the visible ID signature changes:

```js
useEffect(() => {
  if (!ready) return;
  if (visibilitySignatureRef.current !== visibilitySignature) {
    visibilitySignatureRef.current = visibilitySignature;
    setRebuildKey((key) => key + 1);
  }
}, [ready, visibilitySignature]);
```

Filter the complete layout at render time:

```js
.filter((item) => visibleIds.has(item.id))
.filter((item) => !QUOTA_IDS.includes(item.id) || providers.some((p) => 'quota-' + p.id === item.id))
```

Include `visibilitySignature` in the `gridChildren` memo dependencies so the child set updates with the rebuild.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
node --test test/component-visibility.test.js
```

Expected: PASS with 3 tests and 0 failures.

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/Dashboard.jsx test/component-visibility.test.js
git commit -m "fix: apply component visibility settings"
```

---

### Task 3: Full verification and Draft PR

**Files:**
- No production changes unless verification reveals a defect.
- PR description records exact evidence and limitations.

**Interfaces:**
- Consumes: complete branch state.
- Produces: verified Draft PR linked to Issue #2.

- [ ] **Step 1: Run the complete automated test suite**

```bash
npm test
```

Expected: exit code 0 and 0 failures.

- [ ] **Step 2: Build the renderer**

```bash
npm run build:renderer
```

Expected: Vite build exits 0.

- [ ] **Step 3: Perform runtime verification when the environment supports Electron**

Verify both `token-line` and `cost-line` hide/show behavior, persistence, and geometry restoration. Capture screenshots before/after. If Electron cannot be executed in the available environment, record that exact limitation and do not claim screenshot validation.

- [ ] **Step 4: Review the branch diff**

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git diff main...HEAD
```

Confirm only the design/plan, visibility helper/test, and focused Dashboard integration changed.

- [ ] **Step 5: Create a Draft PR**

Title:

```text
fix: restore dashboard component visibility switches
```

Body must include:

```markdown
Fixes #2

## Summary
- derive visible dashboard modules from registry-backed `components.*` settings
- subscribe the React dashboard to live settings broadcasts
- preserve complete layout geometry while filtering rendered GridStack nodes

## Verification
- `node --test test/component-visibility.test.js`
- `npm test`
- `npm run build:renderer`
- runtime/screenshot result or explicit limitation
```

Set `draft: true`. Do not merge.
