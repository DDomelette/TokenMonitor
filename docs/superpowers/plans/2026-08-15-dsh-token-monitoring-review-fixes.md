# DSH Token Monitoring Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every backend commit blocker found in the 2026-08-15 review while preserving the approved Kimi frontend boundary.

**Architecture:** Keep the existing DSH provider and storage model. Make pricing a pure event-time lookup, make telemetry parsing schema-strict, preserve incremental cursors across transient filesystem absence, extend the shared retention boundary to the parallel cost store, and reuse the renderer's Beijing calendar for deterministic curve merging. Each behavior is protected by a failing regression test before production code changes.

**Tech Stack:** Node.js CommonJS main process, Node built-in test runner, Electron Store-compatible persistence, Vite/React renderer ES modules.

## Global Constraints

- Work only in `D:\Deepseek_Monitor\.worktrees\dsh-token-monitoring` on branch `dsh-token-monitoring`.
- Preserve all existing user changes; patch only the files listed in each task.
- Do not add dependencies.
- Do not add DSH to `ProviderBar`, `TokenHeatmap`, token-speed renderer filters, or settings UI; Kimi owns those frontend entries.
- Existing DeepSeek `PRICING`, `getModelPrice`, and `calcCost` behavior must remain unchanged.
- DSH aggregation and retention days use fixed Beijing time (UTC+8), independent of host timezone and DST.
- The user explicitly authorized task-level local commits on 2026-08-15. Create focused commits for review and recovery; do not push, rewrite history, or open a PR.
- For every behavior change: add the regression test, run it and observe the expected failure, implement the smallest fix, then rerun the focused tests.

---

## Task 1: Event-time DSH pricing schedule

**Files:**
- Modify: `src/main/pricing.js`
- Modify: `test/dsh-pricing.test.js`
- Modify: `src/main/providers/dsh/telemetrylog.js`
- Modify: `test/dsh-telemetrylog.test.js`

**Interfaces:**
- Consumes: normalized telemetry event time in milliseconds.
- Produces: `getDshModelPrice(model, timeMs)` and `calcDshCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, timeMs)`.
- Integrates: `parseTelemetryLine` passes its normalized event timestamp to both DSH pricing lookups.
- Preserves: `PRICING`, `getModelPrice`, and `calcCost` contracts.

- [ ] **Step 1: Replace stale DSH price expectations with exact schedule tests**

Add a Beijing timestamp helper and literal rate assertions:

```js
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingMs(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS;
}

test('DSH pricing uses the official rates before the 2026-08-17 effective instant', () => {
  const at = beijingMs(2026, 8, 16, 23, 59);
  assert.deepEqual(getDshModelPrice('deepseek-v4-flash', at), {
    input: 0.001, output: 0.002, cacheHit: 0.00002
  });
  assert.deepEqual(getDshModelPrice('deepseek-v4-pro', at), {
    input: 0.003, output: 0.006, cacheHit: 0.000025
  });
});

test('DSH pricing applies Beijing peak boundaries after the effective instant', () => {
  const cases = [
    [beijingMs(2026, 8, 17, 0, 0), 0.0045],
    [beijingMs(2026, 8, 17, 8, 59), 0.0045],
    [beijingMs(2026, 8, 17, 9, 0), 0.009],
    [beijingMs(2026, 8, 17, 11, 59), 0.009],
    [beijingMs(2026, 8, 17, 12, 0), 0.0045],
    [beijingMs(2026, 8, 17, 13, 59), 0.0045],
    [beijingMs(2026, 8, 17, 14, 0), 0.009],
    [beijingMs(2026, 8, 17, 17, 59), 0.009],
    [beijingMs(2026, 8, 17, 18, 0), 0.0045]
  ];
  cases.forEach(([at, expectedInput]) => {
    assert.equal(getDshModelPrice('deepseek-v4-pro', at).input, expectedInput);
  });
});

test('calcDshCost prices all four raw buckets at the event-time rate', () => {
  const at = beijingMs(2026, 8, 17, 9, 0);
  assert.equal(
    calcDshCost('deepseek-v4-flash', 1000, 2000, 3000, 100, at),
    1 * 0.003 + 2 * 0.009 + 3 * 0.0001 + 0.1 * 0.003
  );
});

test('DSH pricing does not map unlisted reasoner or future models to pro', () => {
  const at = beijingMs(2026, 8, 17, 9, 0);
  assert.equal(getDshModelPrice('deepseek-reasoner', at), undefined);
  assert.equal(getDshModelPrice('some-future-model', at), undefined);
  assert.equal(calcDshCost('deepseek-reasoner', 1000, 0, 0, 0, at), 0);
});
```

Add an integration assertion to `test/dsh-telemetrylog.test.js` so omitting the event-time argument cannot silently return:

```js
test('parseTelemetryLine prices historical rows using the row time', () => {
  const time = beijingMs(2026, 8, 16, 23, 59);
  const record = parseTelemetryLine(JSON.stringify({
    v: 1,
    time,
    sessionId: 's-price',
    model: 'deepseek-v4-pro',
    inputTokens: 1000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  }), {}, time);
  assert.equal(record.cost, 0.003);
});
```

Define the same literal `beijingMs` helper in this test file; do not import pricing implementation helpers to derive the expected value.

- [ ] **Step 2: Run the pricing test and verify RED**

Run:

```powershell
node --test test/dsh-pricing.test.js test/dsh-telemetrylog.test.js
```

Expected: FAIL because current rates are stale, no event time is accepted, peak/off-peak boundaries are absent, and reasoner is still mapped to pro.

- [ ] **Step 3: Implement the immutable three-period rate table**

Replace only the DSH pricing block with this structure:

```js
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DSH_PEAK_PRICING_EFFECTIVE_MS = Date.UTC(2026, 7, 16, 16, 0, 0);

const DSH_PRICING = Object.freeze({
  'deepseek-v4-flash': Object.freeze({
    beforeEffective: Object.freeze({ input: 0.001, output: 0.002, cacheHit: 0.00002 }),
    offPeak: Object.freeze({ input: 0.0015, output: 0.0045, cacheHit: 0.00005 }),
    peak: Object.freeze({ input: 0.003, output: 0.009, cacheHit: 0.0001 })
  }),
  'deepseek-v4-pro': Object.freeze({
    beforeEffective: Object.freeze({ input: 0.003, output: 0.006, cacheHit: 0.000025 }),
    offPeak: Object.freeze({ input: 0.0045, output: 0.0135, cacheHit: 0.00015 }),
    peak: Object.freeze({ input: 0.009, output: 0.027, cacheHit: 0.0003 })
  })
});

function dshModelKey(model) {
  if (typeof model !== 'string') return null;
  if (model.startsWith('deepseek-v4-flash')) return 'deepseek-v4-flash';
  if (model.startsWith('deepseek-v4-pro')) return 'deepseek-v4-pro';
  return null;
}

function isDshPeakTime(timeMs) {
  const shifted = new Date(timeMs + BEIJING_OFFSET_MS);
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return (minute >= 9 * 60 && minute < 12 * 60)
    || (minute >= 14 * 60 && minute < 18 * 60);
}

function getDshModelPrice(model, timeMs) {
  const key = dshModelKey(model);
  const at = timeMs;
  if (!key || !Number.isFinite(at)) return undefined;
  const schedule = DSH_PRICING[key];
  if (at < DSH_PEAK_PRICING_EFFECTIVE_MS) return schedule.beforeEffective;
  return isDshPeakTime(at) ? schedule.peak : schedule.offPeak;
}
```

Update `calcDshCost` to accept `timeMs`, pass it to `getDshModelPrice`, and leave the four-bucket formula unchanged. In `parseTelemetryLine`, pass normalized `ts` to `getDshModelPrice(model, ts)` and `calcDshCost(..., ts)` in the same change so the repository never has an intermediate zero-cost integration. Export `DSH_PEAK_PRICING_EFFECTIVE_MS` only if a test needs the boundary constant; do not alter legacy exports.

- [ ] **Step 4: Run pricing tests and verify GREEN**

Run:

```powershell
node --test test/dsh-pricing.test.js test/dsh-telemetrylog.test.js
```

Expected: all DSH pricing tests pass and the legacy `calcCost` assertion stays green.

- [ ] **Step 5: Review the focused diff**

Run:

```powershell
git diff -- src/main/pricing.js test/dsh-pricing.test.js src/main/providers/dsh/telemetrylog.js test/dsh-telemetrylog.test.js
```

Confirm no generic DeepSeek pricing behavior changed.

---

## Task 2: Strict telemetry schema, event-time cost, and portable roots

**Files:**
- Modify: `src/main/providers/dsh/telemetrylog.js`
- Modify: `test/dsh-telemetrylog.test.js`

**Interfaces:**
- Consumes: one JSONL schema-v1 line and a deterministic `nowMs`.
- Produces: a record only when required types are exact; preserves the Task 1 normalized-`ts` pricing call.
- Preserves: missing model maps to `'unknown'`; missing cache buckets map to zero.

- [ ] **Step 1: Add table-driven strict-schema regressions**

Use a valid literal row and mutate one field per case. Also add `readLocalLog` to the existing top-level destructured telemetrylog import for Task 3:

```js
const {
  parseTelemetryLine,
  resolveTelemetryRoot,
  readLocalLog,
  DEFAULT_ROOT,
  MATCH
} = require('../src/main/providers/dsh/telemetrylog');

test('parseTelemetryLine rejects coercible token values and missing session identity', () => {
  const base = {
    v: 1,
    time: 1786641087069,
    sessionId: 'session-1',
    model: 'deepseek-v4-pro',
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4
  };
  const cases = [
    [{ ...base, time: String(base.time) }, 'invalidTimestamp'],
    [{ ...base, sessionId: null }, 'invalidSessionId'],
    [{ ...base, sessionId: '' }, 'invalidSessionId'],
    [{ ...base, inputTokens: null }, 'invalidTokenCount'],
    [{ ...base, inputTokens: '1' }, 'invalidTokenCount'],
    [{ ...base, outputTokens: true }, 'invalidTokenCount'],
    [{ ...base, cacheReadTokens: false }, 'invalidTokenCount'],
    [{ ...base, cacheWriteTokens: '4' }, 'invalidTokenCount'],
    [{ ...base, model: 7 }, 'invalidModel'],
    [{ ...base, cwd: 7 }, 'invalidCwd']
  ];
  cases.forEach(([row, diagnostic]) => {
    const diagnostics = {};
    assert.equal(parseTelemetryLine(JSON.stringify(row), diagnostics, Date.now()), null);
    assert.equal(diagnostics[diagnostic], 1);
  });
});

test('parseTelemetryLine requires input/output but defaults only absent cache buckets', () => {
  const base = { v: 1, time: 1786641087069, sessionId: 's' };
  const missingInputDiagnostics = {};
  assert.equal(
    parseTelemetryLine(JSON.stringify({ ...base, outputTokens: 1 }), missingInputDiagnostics, Date.now()),
    null
  );
  assert.equal(missingInputDiagnostics.invalidTokenCount, 1);

  const record = parseTelemetryLine(
    JSON.stringify({ ...base, inputTokens: 5, outputTokens: 6 }),
    {},
    Date.now()
  );
  assert.deepEqual(record.usage, { input: 5, cached: 0, output: 6, total: 11 });
});
```

Update path assertions to use native values instead of Windows literals:

```js
const nativeDshHome = path.resolve('test-fixtures', 'dsh-home');
const nativeCustomRoot = path.resolve('test-fixtures', 'custom-telemetry');
assert.equal(
  resolveTelemetryRoot(null, { DSH_HOME: nativeDshHome }),
  path.join(nativeDshHome, 'telemetry')
);
const store = {
  get: (key) => key === 'providers.dsh.telemetryRoot' ? nativeCustomRoot : undefined
};
assert.equal(resolveTelemetryRoot(store, { DSH_HOME: nativeDshHome }), nativeCustomRoot);
assert.equal(resolveTelemetryRoot(null, { DSH_HOME: path.join('.', 'dsh') }), path.resolve('dsh', 'telemetry'));
```

- [ ] **Step 2: Run telemetry tests and verify RED**

Run:

```powershell
node --test test/dsh-telemetrylog.test.js
```

Expected: the new strict cases fail because `Number(...)`, `|| 0`, and `'unknown'` session fallback currently accept malformed rows. Portable path cases should pass on Windows and no longer encode POSIX-invalid expectations.

- [ ] **Step 3: Implement exact schema validation**

In `parseTelemetryLine`:

```js
if (typeof data.time !== 'number' || !Number.isSafeInteger(data.time)) {
  incrementDiagnostic(diagnostics, 'invalidTimestamp');
  return null;
}
const ts = normalizeTimestampMs(data.time, nowMs);
if (ts === null) {
  incrementDiagnostic(diagnostics, 'invalidTimestamp');
  return null;
}
if (typeof data.sessionId !== 'string' || data.sessionId.length === 0) {
  incrementDiagnostic(diagnostics, 'invalidSessionId');
  return null;
}
if (data.model !== undefined && typeof data.model !== 'string') {
  incrementDiagnostic(diagnostics, 'invalidModel');
  return null;
}
if (data.cwd !== undefined && typeof data.cwd !== 'string') {
  incrementDiagnostic(diagnostics, 'invalidCwd');
  return null;
}

const input = data.inputTokens;
const output = data.outputTokens;
const cacheRead = data.cacheReadTokens === undefined ? 0 : data.cacheReadTokens;
const cacheWrite = data.cacheWriteTokens === undefined ? 0 : data.cacheWriteTokens;
if (![input, output, cacheRead, cacheWrite]
    .every((n) => Number.isSafeInteger(n) && n >= 0)) {
  incrementDiagnostic(diagnostics, 'invalidTokenCount');
  return null;
}
```

Keep model fallback only for an absent/empty string, retain the validated `sessionId`, and verify the Task 1 pricing calls still include `ts`:

```js
if (!getDshModelPrice(model, ts)) incrementDiagnostic(diagnostics, 'unknownModel');
// ...
cost: calcDshCost(model, input, output, cacheRead, cacheWrite, ts)
```

- [ ] **Step 4: Run schema, pricing, and scheduler integration tests**

Run:

```powershell
node --test test/dsh-telemetrylog.test.js test/dsh-pricing.test.js test/dsh-provider-scheduler.test.js test/dsh-history-rescan.test.js
```

Expected: all pass; known DSH rows have non-zero event-time cost and malformed rows never reach aggregation.

- [ ] **Step 5: Review the focused diff**

Run:

```powershell
git diff -- src/main/providers/dsh/telemetrylog.js test/dsh-telemetrylog.test.js
```

Confirm no value coercion or fabricated session identity remains.

---

## Task 3: Preserve cursors through transient root/file absence

**Files:**
- Modify: `src/main/providers/dsh/telemetrylog.js`
- Modify: `test/dsh-telemetrylog.test.js`

**Interfaces:**
- Consumes: the stored cursor snapshot and current filesystem enumeration.
- Produces: cursor advancement for files read this round; unchanged stored cursors for files absent this round.
- Explicit reset: `rescanLocalLogs` continues to clear `localLogCursors.dsh` for a requested full rebuild.

- [ ] **Step 1: Replace the unsafe GC expectation with a cursor-preservation test**

```js
test('readLocalLog preserves cursors when a previously scanned file is absent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const missing = path.join(root, 'usage-2026-08-10.jsonl');
  const cursor = { offset: 42, mtimeMs: 1, lastEventFingerprint: 'sha256:old' };
  const store = makeSnapshotStore({
    usageDaily: {},
    usageDailyCost: {},
    localLogCursors: { dsh: { [missing]: cursor } },
    providers: { dsh: { telemetryRoot: root } },
    data: { historyDays: 30 }
  });

  const batch = await readLocalLog({ store }, { nowMs: Date.UTC(2026, 7, 14, 4) });

  assert.equal(batch.records.length, 0);
  assert.equal(store.writes, 0);
  assert.deepEqual(store.get('localLogCursors.dsh'), { [missing]: cursor });
});
```

Add the end-to-end recovery oracle:

```js
test('a telemetry root disappearing and returning does not double-count prior rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-telemetry-'));
  const offlineRoot = root + '-offline';
  const dayFile = 'usage-2026-08-14.jsonl';
  writeRows(root, dayFile, [{
    v: 1,
    time: Date.UTC(2026, 7, 14, 2),
    sessionId: 's1',
    model: 'deepseek-v4-pro',
    inputTokens: 100,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  }]);
  const store = makeStore({
    usageDaily: {},
    usageDailyCost: {},
    providers: { dsh: { telemetryRoot: root } },
    data: { historyDays: 30 }
  });
  const options = { nowMs: Date.UTC(2026, 7, 14, 4) };

  await readLocalLog({ store }, options);
  const firstCursor = JSON.parse(JSON.stringify(store.get('localLogCursors.dsh')));
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].total, 100);

  fs.renameSync(root, offlineRoot);
  try {
    await readLocalLog({ store }, options);
    assert.deepEqual(store.get('localLogCursors.dsh'), firstCursor);
  } finally {
    fs.renameSync(offlineRoot, root);
  }

  await readLocalLog({ store }, options);
  assert.equal(store.get('usageDaily')['dsh:2026-08-14'].total, 100);
});
```

- [ ] **Step 2: Run telemetry tests and verify RED**

Run:

```powershell
node --test test/dsh-telemetrylog.test.js
```

Expected: FAIL because the post-scan deletion loop clears the absent cursor; the recovery test reports total `200` instead of `100`.

- [ ] **Step 3: Remove enumeration-based cursor deletion**

Delete this block from `scanTelemetryBatch`:

```js
for (const identity of Object.keys(cursors)) {
  if (!files.includes(identity)) delete cursors[identity];
}
```

Update `cursorsChanged` and `readLocalLog` comments so they mention only cursor advancement, not stale-entry GC. Do not add a replacement automatic GC policy.

- [ ] **Step 4: Run cursor and history-rescan regressions**

Run:

```powershell
node --test test/dsh-telemetrylog.test.js test/dsh-history-rescan.test.js test/locallog-chunked-scan.test.js
```

Expected: all pass; explicit full rescan still resets and rebuilds, while passive polling preserves absent cursors.

- [ ] **Step 5: Review the focused diff**

Run:

```powershell
git diff -- src/main/providers/dsh/telemetrylog.js test/dsh-telemetrylog.test.js
```

Confirm the only cursor deletion path left is the explicit history-rescan reset.

---

## Task 4: Apply retention to daily costs

**Files:**
- Modify: `src/main/core/usage-retention.js`
- Modify: `test/usage-retention.test.js`

**Interfaces:**
- Consumes: `data.historyDays`, `usageDaily`, and `usageDailyCost`.
- Produces: both stores filtered with the same Beijing start/end days in one cleanup invocation.
- Preserves: `pruneUsageDaily` returns the number of removed `usageDaily` rows, not cost rows.

- [ ] **Step 1: Extend the physical-cleanup regression fixture**

Add cost rows to the existing test:

```js
usageDailyCost: {
  'dsh:2026-08-02': 0.2,
  'dsh:2026-08-03': 0.3,
  'dsh:2026-08-05': 0.5
},
```

After cleanup assert:

```js
assert.equal(removed, 1);
assert.deepEqual(data.usageDailyCost, {
  'dsh:2026-08-03': 0.3,
  'dsh:2026-08-05': 0.5
});
assert.deepEqual(writes.map((entry) => entry[0]), ['usageDaily', 'usageDailyCost']);
```

Keep strict identity assertions for cursor and fetched-month objects.

- [ ] **Step 2: Run retention tests and verify RED**

Run:

```powershell
node --test test/usage-retention.test.js
```

Expected: FAIL because `usageDailyCost` is unchanged and only `usageDaily` is written.

- [ ] **Step 3: Filter the parallel cost store with the same inputs**

In `pruneUsageDaily`, after filtering usage rows:

```js
const currentCost = store.get('usageDailyCost') || {};
const filteredCost = filterUsageDaily(currentCost, historyDays, nowMs);
const removedCost = Math.max(0, Object.keys(currentCost).length - Object.keys(filteredCost).length);

if (removed > 0) store.set('usageDaily', filtered);
if (removedCost > 0) store.set('usageDailyCost', filteredCost);
return removed;
```

Do not touch any cursor, fetched-month, provider, or settings key.

- [ ] **Step 4: Run retention and settings integration tests**

Run:

```powershell
node --test test/usage-retention.test.js test/settings-close-durability.test.js test/settings-security.test.js test/dsh-dashboard.test.js test/dsh-dashboard-ipc.test.js
```

Expected: all pass; a shortened history window removes matching cost days before dashboard reads.

- [ ] **Step 5: Review the focused diff**

Run:

```powershell
git diff -- src/main/core/usage-retention.js test/usage-retention.test.js
```

Confirm the return contract and non-retention keys are unchanged.

---

## Task 5: Make curve merging host-timezone independent

**Files:**
- Modify: `renderer/src/lib/curve-merge.js`
- Modify: `test/curve-merge.test.js`

**Interfaces:**
- Consumes: curve points whose `time` is an epoch timestamp.
- Produces: one point per Beijing day with output `time` fixed to UTC midnight for that day.
- Reuses: `beijingDayKey` from `renderer/src/lib/beijing-calendar.js`.

- [ ] **Step 1: Add a UTC-minus-host regression**

Change the test point constructor to `Date.UTC`:

```js
function point(dateStr, totalCost, deltaCost) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { time: Date.UTC(y, m - 1, d), totalCost, deltaCost };
}
```

Add an isolated timezone assertion:

```js
test('mergeCurves keeps Beijing day keys stable on a UTC-minus host', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const merged = mergeCurves([[
      point('2026-08-14', 0.2, 0.2),
      point('2026-08-15', 0.5, 0.3)
    ]]);
    assert.deepEqual(merged.map((p) => p.time), [
      Date.UTC(2026, 7, 14),
      Date.UTC(2026, 7, 15)
    ]);
    assertClose(merged.map((p) => p.totalCost), [0.2, 0.5]);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});
```

- [ ] **Step 2: Run curve tests and verify RED**

Run:

```powershell
node --test test/curve-merge.test.js
```

Expected: FAIL because local getters classify UTC midnight as the previous day in Los Angeles and local-midnight output differs from UTC midnight.

- [ ] **Step 3: Reuse the Beijing calendar and stable output timestamp**

At the top of `curve-merge.js`:

```js
import { beijingDayKey } from './beijing-calendar.js';
```

Remove the local `localDayKey` implementation. In `mergeCurves`, use:

```js
const key = beijingDayKey(t);
if (!key) return;
```

Construct output points with:

```js
const [y, m, d] = day.split('-').map(Number);
out.push({ time: Date.UTC(y, m - 1, d), totalCost: cumulative, deltaCost: delta });
```

- [ ] **Step 4: Run renderer calendar and curve regressions**

Run:

```powershell
node --test test/curve-merge.test.js test/beijing-calendar.test.js
npm run build:renderer
```

Expected: both test files and the Vite build pass; `test/beijing-calendar.test.js` already exercises the renderer calendar in isolated host timezones.

- [ ] **Step 5: Review the focused diff**

Run:

```powershell
git diff -- renderer/src/lib/curve-merge.js test/curve-merge.test.js
```

Confirm there are no host-local date getters or local-midnight constructors left in the merge helper.

---

## Task 6: Documentation consistency and full commit-readiness verification

**Files:**
- Modify: `docs/superpowers/plans/2026-08-14-dsh-token-monitoring.md`
- Verify: all files currently changed in the worktree

**Interfaces:**
- Produces: documentation that distinguishes the existing cost-line merge from Kimi-owned DSH platform entries.
- Produces: fresh, recorded evidence for test, build, whitespace, status, and platform portability.

- [ ] **Step 1: Correct the superseded plan statements**

At the top of the original plan, add:

```markdown
> **2026-08-15 review correction:** The pricing, strict-schema, cursor-absence,
> retention, and curve-timezone details in Tasks 6-8 are superseded by
> `docs/superpowers/plans/2026-08-15-dsh-token-monitoring-review-fixes.md`.
> The approved frontend boundary excludes new DSH platform entries, but permits
> merging DSH cost into the existing cost-line widget.
```

Replace â€œ`renderer/` ä¸€è¡Œä¸æ”¹â€ with â€œä¸æ–°å¢ DSH å¹³å°å…¥å£æˆ–ç‹¬ç«‹é¢æ¿;å…è®¸ä¿®æ”¹ç°æœ‰ cost-line æ•°æ®åˆå¹¶è·¯å¾„â€ã€‚ Update the self-review statement that claims all renderer files are untouched. Do not rewrite historical task bodies beyond adding the supersession notice.

- [ ] **Step 2: Run every focused repair suite together**

Run:

```powershell
node --test test/dsh-pricing.test.js test/dsh-telemetrylog.test.js test/dsh-provider-scheduler.test.js test/dsh-history-rescan.test.js test/usage-retention.test.js test/dsh-dashboard.test.js test/dsh-dashboard-ipc.test.js test/curve-merge.test.js
```

Expected: zero failures.

- [ ] **Step 3: Run the entire repository test suite**

Run:

```powershell
npm test
```

Expected: exit code 0; any intentional skip must be reported, and no failure may be dismissed as unrelated without root-cause verification.

- [ ] **Step 4: Build the renderer from current sources**

Run:

```powershell
npm run build:renderer
```

Expected: exit code 0. The existing Vite chunk-size advisory is non-blocking; any compilation/import error is blocking.

- [ ] **Step 5: Verify portable path behavior**

First check whether WSL and Node are available:

```powershell
wsl.exe bash -lc "node --version"
```

If available, run:

```powershell
wsl.exe bash -lc "cd /mnt/d/Deepseek_Monitor/.worktrees/dsh-token-monitoring && node --test test/dsh-telemetrylog.test.js test/dsh-pricing.test.js"
```

If unavailable, report that limitation and retain the platform-native path fixtures plus the Los Angeles timezone regression as deterministic portability evidence; do not claim an actual Linux run.

- [ ] **Step 6: Perform final Git hygiene checks**

Run:

```powershell
git diff --check HEAD
git status --short --branch
git diff --cached --stat
```

Expected: no whitespace errors, no conflict markers, the intended modified/untracked files remain visible, and the staged diff is empty. LF-to-CRLF conversion notices are informational if `git diff --check` exits 0.

- [ ] **Step 7: Compare implementation to the approved design**

Check every requirement in `docs/superpowers/specs/2026-08-14-dsh-token-monitoring-design.md` sections 4.2, 4.4, 4.6, 5, 6, and 7.5. Confirm no DSH platform entries were added to Kimi-owned renderer lists and no unrelated file was changed.

- [ ] **Step 8: Hand off without remote Git mutation**

Report the exact test/build counts, any skipped checks, remaining warnings, and the local commits created. Do not push, rewrite history, or open a PR.

---

## ºóĞøĞŞ¶©(2026-08-14 ×·¼Ó):ÒÆ³ı dsh ÔöÁ¿É¨ÃèµÄÄÚÈİÖ¸ÎÆÈ¥ÖØ

ÉÏÓÎ DSH ¸ÄÎª attempt ¼¶¼ÇÂ¼ºó,Í¬ºÁÃë¡¢Í¬»á»°¡¢Í¬Ä£ĞÍ¡¢Í¬ËÄÍ°µÄË« attempt »á²úÉú**×Ö½ÚÍêÈ«ÏàÍ¬**µÄÁ½ĞĞ;Ô­ lastEventFingerprint ÄÚÈİÈ¥ÖØ»áÎóÉ±µÚ¶şÌõµ¼ÖÂÂ©¼Æ¡£ÓÖÒò M3 ÒÑ°Ñ usageDaily/usageDailyCost/ÓÎ±ê¸ÄÎªµ¥´ÎÔ­×ÓÌá½»,Êı¾İÓëÓÎ±êÍ¬µ¥ÔªÂäÅÌ,"ÓÎ±êÂäºóÓÚÊı¾İ"µÄÖØ·ÅÌ¬²»¿É´ï,ÄÚÈİÈ¥ÖØÖ»ÓĞ»µ´¦¡£

ĞŞ¸Ä:
- src/main/providers/dsh/telemetrylog.js:ÔöÁ¿Â·¾¶ÒÆ³ı lastEventFingerprint ±ß½çÈ¥ÖØÓëÓÎ±ê×Ö¶ÎĞ´»Ø;eventFingerprint ±£ÁôÎªĞĞÔªÊı¾İ,seenFingerprints ÏÔÊ½ÖØ½¨È¥ÖØ·ÖÖ§²»±ä¡£
- 	est/dsh-telemetrylog.test.js:Ô­"skips a re-read line"ÓÃÀı¸ÄĞ´Îª"stale cursor re-emits the line";ĞÂÔö"Á½Ìõ×Ö½ÚÏàÍ¬µÄÁ¬Ğø attempt ĞĞÈ«²¿¼ÆÊı"»Ø¹éÓÃÀı(TDD ºì¡úÂÌ)¡£
- docs/superpowers/specs/2026-08-14-dsh-token-monitoring-design.md:¡ì5 ÓÎ±êĞĞ¡¢ÊÂ¼şÖ¸ÎÆËµÃ÷¡¢¡ì6 Monitor ²âÊÔ 3¡¢¡ì7.5(5)¡¢¡ì8 ÑéÊÕ 1 Í¬²½¸üĞÂ¡£

ÑéÖ¤:
ode --test(È«Á¿)Óë dsh Ïà¹Ø²âÊÔÈ«ÂÌ;ÎŞÌá½»,¸Ä¶¯Áô¹¤×÷Çø¡£
