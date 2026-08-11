# Accurate Beijing Usage Statistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daily usage aggregation deterministic, duplicate-safe, complete for large local logs, and fixed to the Beijing UTC+8 settlement calendar without automatically rebuilding existing user data.

**Architecture:** Introduce small Beijing-calendar modules at the main/renderer boundaries, change local-log reads to return an explicit `ScanBatch`, persist Codex cumulative-usage state in each file cursor, and coordinate manual rescans through a scheduler-owned keyed execution queue. Manual rescans retain the current incremental storage format, but snapshot and restore one provider's rows/cursor on failure.

**Tech Stack:** Electron 40, Node.js CommonJS main process, React/Vite renderer with ES modules, `node:test`, `electron-store`.

## Global Constraints

- Beijing settlement time is fixed UTC+8 and must not depend on the operating-system timezone or daylight-saving rules.
- Token `total` continues to include cached input; `cached` remains a subset displayed separately.
- Existing `usageDaily` data is not rebuilt or mutated automatically at startup or upgrade.
- Codex/Kimi history is corrected only after the user manually invokes history sync.
- A local-log rescan may report success only after the scanner returns `complete: true`.
- Failure restores the selected provider's prior daily rows and cursor without touching other providers.
- Do not add a database, event index, or unrelated refactor.

---

## File Structure

- Create `src/main/core/beijing-calendar.js`: CommonJS UTC+8 date/day primitives used by main-process collectors and retention.
- Create `renderer/src/lib/beijing-calendar.js`: dependency-free ES module UTC+8 primitives used by charts, fee cards, and the heatmap clock.
- Modify `src/main/core/locallog.js`: return `ScanBatch`, report completion/bytes, persist Codex dedupe state, and aggregate by Beijing day.
- Modify `src/main/providers/codex/locallog.js` and `src/main/providers/kimi/locallog.js`: consume/return `ScanBatch`; Codex emits cumulative usage markers.
- Modify `src/main/core/history-sync.js`: loop on `complete`, enforce explicit incomplete failure, and roll back provider rows/cursor.
- Modify `src/main/core/scheduler.js` and `src/main/ipc.js`: add keyed exclusive execution and place the whole provider rescan under it.
- Modify main/renderer date consumers to use Beijing calendar primitives.
- Extend existing focused tests; create `test/beijing-calendar.test.js` and `test/local-log-rescan-integration.test.js` for cross-boundary behavior.

---

### Task 1: Fixed Beijing Calendar in Main and Renderer

**Files:**
- Create: `src/main/core/beijing-calendar.js`
- Create: `renderer/src/lib/beijing-calendar.js`
- Create: `test/beijing-calendar.test.js`
- Modify: `src/main/core/usage-retention.js`
- Modify: `src/main/core/locallog.js`
- Modify: `src/main/providers/deepseek/usage.js`
- Modify: `src/main/core/history-sync.js`
- Modify: `src/main/core/scheduler.js`
- Modify: `src/main/ipc.js`
- Modify: `src/main/core/token-speed-runtime.js`
- Modify: `renderer/src/fee-card-date.mjs`
- Modify: `renderer/src/lib/local-calendar-clock.js`
- Modify: `renderer/src/components/ProviderBar.jsx`
- Modify: `test/usage-retention.test.js`
- Modify: `test/locallog-dst-day-key.test.js`
- Modify: `test/fee-card-yesterday.test.js`
- Modify: `test/heatmap-local-calendar-clock.test.js`

**Interfaces:**
- Produces main-process functions `beijingDayKey(value)`, `beijingDateParts(value)`, `addBeijingDays(dayKey, delta)`, and `millisecondsUntilNextBeijingMidnight(value)`.
- Produces renderer functions with the same names from an ES module.
- Keeps existing public helpers such as `localDayStr`, `localTodayStr`, `localDateKey`, and `localDayKey` as compatibility wrappers, but changes their semantics to Beijing time.

- [ ] **Step 1: Write failing timezone-invariance tests**

Create `test/beijing-calendar.test.js` with literal expectations that execute the main module under multiple `TZ` values:

```js
test('the same instant always belongs to the Beijing settlement day', () => {
  for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
    assert.deepEqual(evaluate(zone, '2026-08-10T16:30:00.000Z'), {
      dayKey: '2026-08-11',
      year: 2026,
      month: 8,
      day: 11
    });
  }
});

test('Beijing calendar addition crosses month and year boundaries', () => {
  assert.equal(addBeijingDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addBeijingDays('2024-02-28', 1), '2024-02-29');
});
```

Update existing timezone tests so UTC and Los Angeles expect the same Beijing day/yesterday/year as Shanghai. Add a clock assertion using `2026-12-31T16:00:00.000Z` that resolves to Beijing year 2027.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test test/beijing-calendar.test.js test/usage-retention.test.js test/locallog-dst-day-key.test.js test/fee-card-yesterday.test.js test/heatmap-local-calendar-clock.test.js
```

Expected: FAIL because the Beijing calendar modules do not exist and existing helpers follow `TZ`.

- [ ] **Step 3: Implement minimal Beijing calendar modules**

Use UTC getters only after adding the fixed offset:

```js
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingDateParts(value = Date.now()) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  const shifted = new Date(timestamp + BEIJING_OFFSET_MS);
  if (!Number.isFinite(shifted.getTime())) return null;
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate()
  };
}

function beijingDayKey(value = Date.now()) {
  const parts = beijingDateParts(value);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}
```

Validate `YYYY-MM-DD` inputs with `Date.UTC`, implement `addBeijingDays` with UTC calendar arithmetic, and calculate the next Beijing midnight from `Date.UTC(year, month - 1, day + 1) - BEIJING_OFFSET_MS`.

- [ ] **Step 4: Route every settlement-date consumer through the helpers**

Replace local-time field access in retention, local-log rollup, DeepSeek `localTodayStr`, DeepSeek history-sync month iteration/cutoff, scheduler usage month/year, IPC default heatmap year, token-speed daily observation, renderer fee-card yesterday, heatmap clock, and provider-bar `lastDays`. Preserve public wrapper names where existing imports rely on them.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all listed tests PASS in every spawned timezone.

- [ ] **Step 6: Commit the Beijing calendar task**

```powershell
git add src/main/core/beijing-calendar.js renderer/src/lib/beijing-calendar.js src/main/core/usage-retention.js src/main/core/locallog.js src/main/providers/deepseek/usage.js src/main/core/history-sync.js src/main/core/scheduler.js src/main/ipc.js src/main/core/token-speed-runtime.js renderer/src/fee-card-date.mjs renderer/src/lib/local-calendar-clock.js renderer/src/components/ProviderBar.jsx test/beijing-calendar.test.js test/usage-retention.test.js test/locallog-dst-day-key.test.js test/fee-card-yesterday.test.js test/heatmap-local-calendar-clock.test.js
git commit -m "fix: use Beijing calendar for daily usage"
```

---

### Task 2: Explicit Scan Completion and Transactional Rescan

**Files:**
- Modify: `src/main/core/locallog.js`
- Modify: `src/main/providers/codex/locallog.js`
- Modify: `src/main/providers/kimi/locallog.js`
- Modify: `src/main/providers/types.js`
- Modify: `src/main/core/history-sync.js`
- Modify: `src/main/core/scheduler.js`
- Modify: `scripts/verify-locallog.js`
- Modify: `test/locallog.test.js`
- Modify: `test/locallog-chunked-scan.test.js`
- Modify: `test/locallog-chunked-recovery.test.js`
- Modify: `test/locallog-stable-evaluation-time.test.js`
- Modify: `test/locallog-invalid-timestamp.test.js`
- Modify: `test/locallog-retain-all.test.js`
- Modify: `test/settings-reset-codex-data-integrity.test.js`
- Modify: `test/settings-reset-kimi-history-integrity.test.js`
- Modify: `test/history-sync.test.js`

**Interfaces:**
- Changes `scanFiles(options)` and provider `readLocalLog(ctx, opts)` to resolve a `ScanBatch`:

```js
{
  records: UsageRecord[],
  complete: boolean,
  bytesRead: number
}
```

- Changes `rescanLocalLogs(options)` to stop only on `batch.complete === true` and to return `{daysRebuilt, earliestDate, passes, records, bytesRead}`.
- Uses `MAX_SCAN_PASSES = 10_000` as the production safety limit and raises an error with `code === 'LOCAL_LOG_RESCAN_INCOMPLETE'` when the injectable limit is reached before completion.

- [ ] **Step 1: Write failing scanner contract tests**

Add real temporary-file tests with hand-derived results:

```js
test('scanFiles reports incomplete when the byte budget leaves files unread', async () => {
  const first = await scanFixture({ maxBytesPerScan: firstLineBytes });
  assert.equal(first.records.length, 1);
  assert.equal(first.complete, false);
  assert.equal(first.bytesRead, firstLineBytes);

  const second = await scanFixture({ maxBytesPerScan: firstLineBytes });
  assert.equal(second.complete, true);
});
```

Add a fixture whose first budget-sized region contains valid JSONL but no usage event. Assert that `records` is empty while `complete` is false.

- [ ] **Step 2: Write failing rescan and rollback tests**

In `test/history-sync.test.js`, drive `rescanLocalLogs` with 201 incomplete batches followed by a complete batch. Assert 202 calls and success. Add a separate `maxPasses: 2` test that returns incomplete twice, expects `LOCAL_LOG_RESCAN_INCOMPLETE`, and verifies the original provider rows/cursor were restored while another provider row stayed untouched.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
node --test test/locallog.test.js test/locallog-chunked-scan.test.js test/locallog-chunked-recovery.test.js test/history-sync.test.js
```

Expected: FAIL because reads still return arrays and rescan stops on record count/200 passes.

- [ ] **Step 4: Implement `ScanBatch` in the scanner and providers**

Track `bytesRead` on every successful file read. Start `complete=true`, set it false whenever the budget prevents visiting a remaining file or leaves `readPosition < stat.size`, and return `{records, complete, bytesRead}`. A root that does not exist returns `{records: [], complete: true, bytesRead: 0}`. A trailing line without a newline remains uncommitted but does not make an otherwise fully visited snapshot incomplete; a later append lets the incremental scan reread it. Provider adapters roll up `batch.records`, then return the full batch.

Update scheduler and scripts to read `batch.records`; update ProviderAdapter documentation to the new shape.

- [ ] **Step 5: Implement completion-driven rescan and rollback**

Snapshot only matching provider rows plus a deep copy of `localLogCursors.<provider>`. Accumulate `passes`, `records`, and `bytesRead` until `complete`. If the pass limit is exhausted, throw:

```js
const error = new Error(`Local log rescan incomplete for ${providerId}`);
error.code = 'LOCAL_LOG_RESCAN_INCOMPLETE';
error.providerId = providerId;
error.passes = passes;
error.bytesRead = bytesRead;
throw error;
```

Catch any error, delete newly written rows for that provider, restore the snapshot rows and cursor, then rethrow.

- [ ] **Step 6: Update affected tests to assert the new real contract**

Replace array-length assertions with `batch.records.length` and add `complete` assertions at chunk boundaries. Do not add source-text assertions for this behavior.

- [ ] **Step 7: Run all local-log/history tests and verify GREEN**

Run:

```powershell
node --test test/locallog*.test.js test/history-sync.test.js test/scheduler-locallog-broadcast.test.js test/settings-reset-codex-data-integrity.test.js test/settings-reset-kimi-history-integrity.test.js
```

Expected: all matching tests PASS.

- [ ] **Step 8: Commit the scan protocol task**

```powershell
git add src/main/core/locallog.js src/main/providers/codex/locallog.js src/main/providers/kimi/locallog.js src/main/providers/types.js src/main/core/history-sync.js src/main/core/scheduler.js scripts/verify-locallog.js test
git commit -m "fix: complete large local-log rescans"
```

---

### Task 3: Codex Cumulative Snapshot Deduplication

**Files:**
- Modify: `src/main/providers/codex/locallog.js`
- Modify: `src/main/core/locallog.js`
- Modify: `test/locallog.test.js`
- Modify: `test/locallog-chunked-scan.test.js`
- Create: `test/codex-usage-deduplication.test.js`

**Interfaces:**
- Adds optional `usageTotal` to a parsed Codex `UsageRecord`, sourced from `total_token_usage.total_tokens` only when it is finite.
- Adds optional `lastUsageTotal` to each file cursor.
- Scanner suppresses a record only when finite `record.usageTotal === cursor.lastUsageTotal`.

- [ ] **Step 1: Write failing duplicate-event tests**

Create a temporary rollout file with literal events:

```js
const events = [
  tokenEvent('2026-08-11T01:00:00Z', 10, 10),
  tokenEvent('2026-08-11T01:00:01Z', 10, 10),
  tokenEvent('2026-08-11T01:00:02Z', 15, 5)
];
```

Assert the aggregate total is 15 rather than 25 and the emitted record count is 2. Force the first and second duplicate events into separate byte-budget batches and assert the second batch emits zero records because `lastUsageTotal` survived in the cursor.

- [ ] **Step 2: Write failing compatibility/reset tests**

Add tests proving: a cumulative decrease `20 -> 4` counts the reset record; missing `total_token_usage` counts normally; truncating/replacing the file clears `lastUsageTotal` and allows the first new record.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
node --test test/codex-usage-deduplication.test.js test/locallog.test.js test/locallog-chunked-scan.test.js
```

Expected: duplicate totals are counted and the cursor lacks `lastUsageTotal`.

- [ ] **Step 4: Emit and persist cumulative usage state**

In `parseRolloutLine`, read the cumulative total without changing the existing `last_token_usage` fields:

```js
const cumulative = payload.info.total_token_usage;
const usageTotal = cumulative && Number(cumulative.total_tokens);
return {
  ts,
  usage: parsedUsage,
  ...(Number.isFinite(usageTotal) ? { usageTotal } : {})
};
```

In `scanFiles`, compare `usageTotal` with the current file cursor before pushing. Update `lastUsageTotal` after every non-malformed Codex usage record, including a skipped duplicate. Reset the field whenever offset resets to zero because of truncation or replacement.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 3 command. Expected: all tests PASS.

- [ ] **Step 6: Commit the Codex dedupe task**

```powershell
git add src/main/providers/codex/locallog.js src/main/core/locallog.js test/locallog.test.js test/locallog-chunked-scan.test.js test/codex-usage-deduplication.test.js
git commit -m "fix: deduplicate Codex cumulative usage snapshots"
```

---

### Task 4: Scheduler-Owned Exclusive Local-Log Rescans

**Files:**
- Modify: `src/main/core/scheduler.js`
- Modify: `src/main/ipc.js`
- Modify: `test/scheduler.test.js`
- Modify: `test/scheduler-locallog-broadcast.test.js`
- Modify: `test/history-sync-ipc.test.js`
- Create: `test/local-log-rescan-integration.test.js`

**Interfaces:**
- Adds `scheduler.runExclusive(providerId, channel, fn): Promise<unknown>`.
- Keeps timer/manual `runOnce` coalescing behavior: when a key already has a queued/running Promise, it returns that Promise without invoking a second function.
- `runExclusive` always queues its function after the current keyed Promise and holds the key until completion.

- [ ] **Step 1: Write failing keyed-execution tests**

Use deferred Promises to assert observable execution order:

```js
const first = scheduler.runExclusive('codex', 'localLog', async () => {
  order.push('first:start');
  await gate;
  order.push('first:end');
});
const second = scheduler.runExclusive('codex', 'localLog', async () => {
  order.push('second');
});

assert.deepEqual(order, ['first:start']);
release();
await Promise.all([first, second]);
assert.deepEqual(order, ['first:start', 'first:end', 'second']);
```

Add a different-provider assertion showing Kimi can execute while Codex is held.

- [ ] **Step 2: Write failing IPC/rescan concurrency integration test**

Register the real history-sync IPC handler with a scheduler exposing the real keyed queue and a provider whose `readLocalLog` blocks. Trigger a background local-log poll while rescan holds the key. Assert the provider never has two active readers and that the rebuilt total is added once.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
node --test test/scheduler.test.js test/scheduler-locallog-broadcast.test.js test/history-sync-ipc.test.js test/local-log-rescan-integration.test.js
```

Expected: FAIL because `runExclusive` is absent and IPC calls the provider outside the scheduler key.

- [ ] **Step 4: Implement keyed queue plus coalescing**

Replace the `Set` with a map of tracked Promises. Implement `runExclusive` by chaining after the prior Promise (swallowing only the prior rejection for queue continuity), storing the tracked Promise, and deleting it only if it is still the map's tail. Implement `runOnce` as “return existing tail, otherwise call `runExclusive`”. Export `runExclusive` on the scheduler object.

- [ ] **Step 5: Put the entire provider rescan under the scheduler key**

In `sync:history`, construct `runRescan` and call:

```js
summary[pid] = typeof deps.scheduler.runExclusive === 'function'
  ? await deps.scheduler.runExclusive(pid, 'localLog', runRescan)
  : await runRescan();
```

The compatibility fallback keeps focused IPC harnesses working; production always uses the scheduler method. The callback calls the provider directly so it does not reacquire the same key.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 3 command. Expected: all tests PASS and max concurrent readers equals 1.

- [ ] **Step 7: Commit the scheduler locking task**

```powershell
git add src/main/core/scheduler.js src/main/ipc.js test/scheduler.test.js test/scheduler-locallog-broadcast.test.js test/history-sync-ipc.test.js test/local-log-rescan-integration.test.js
git commit -m "fix: serialize manual and scheduled log scans"
```

---

### Task 5: Idempotence Regression and End-to-End Verification

**Files:**
- Modify: `test/local-log-rescan-integration.test.js`
- Modify: `docs/superpowers/plans/2026-08-11-accurate-beijing-usage-statistics.md` only to check completed boxes during execution.

**Interfaces:**
- Consumes the `ScanBatch`, Beijing calendar, Codex cursor dedupe, rollback, and scheduler exclusive APIs from Tasks 1–4.
- Produces no new production API.

- [ ] **Step 1: Write failing/relevant end-to-end idempotence test**

Build temporary Codex and Kimi roots with multiple days, duplicate Codex cumulative snapshots, a chunk containing no usage record, and enough padding to require multiple batches. Run the real provider readers through `rescanLocalLogs` twice against the same in-memory store. Assert literal daily rows after each run and deep equality between runs.

- [ ] **Step 2: Verify the regression test fails if dedupe is disabled**

Temporarily run the test against the pre-dedupe behavior (or locally revert the dedupe hunk without committing), confirm the Codex literal total fails, restore the implementation, and rerun. This is the required mutation check for the original bug.

- [ ] **Step 3: Run the complete Node test suite**

Run:

```powershell
npm test
```

Expected: exit code 0 with zero failed tests.

- [ ] **Step 4: Build the renderer**

Run:

```powershell
npm run build:renderer
```

Expected: Vite exits 0 and emits the renderer bundle without import or syntax errors.

- [ ] **Step 5: Audit the final diff and requirements**

Run:

```powershell
git diff --check HEAD~4..HEAD
git status --short
git log -5 --oneline
```

Confirm: no startup migration exists; no automatic history-sync invocation exists; every rescan completion uses `complete`; every date boundary named in the design uses Beijing helpers; failures restore provider rows/cursor.

- [ ] **Step 6: Commit the integration regression if it changed after Task 4**

```powershell
git add test/local-log-rescan-integration.test.js docs/superpowers/plans/2026-08-11-accurate-beijing-usage-statistics.md
git commit -m "test: cover idempotent local-log history rebuilds"
```

- [ ] **Step 7: Hand off manual data correction**

Do not invoke `sync:history` against the user's live store. Report that the user must restart the fixed application and click “同步历史数据” once; subsequent identical manual scans must remain stable.
