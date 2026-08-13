# Codex Archive Usage Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically rebuild Codex daily usage from active and archived rollout logs without mutating the live store until the rebuild is complete, then keep future usage exact when rollout files move between those directories.

**Architecture:** Extend the chunked scanner with an explicit completion protocol, then build a Codex-specific dual-root scanner whose persisted cursors are keyed by stable rollout identity instead of path. A dedicated shadow-rebuild service globally deduplicates events and atomically replaces only Codex state; a small runtime coordinator serializes startup migration, manual rebuilds, and incremental scans while retaining a legacy fallback after migration failure.

**Tech Stack:** Electron 40, Node.js CommonJS main process, `node:test`, `electron-store`, asynchronous `fs.promises`, SHA-256 from `node:crypto`.

## Global Constraints

- Default Codex inputs are `~/.codex/sessions` and `~/.codex/archived_sessions`.
- `providers.codex.localLogRoot` remains the custom active root; a custom archive is enabled only by explicit `providers.codex.archivedLogRoot`.
- Persisted Codex cursors are keyed by rollout UUID, falling back to the complete basename only when no terminal UUID can be parsed.
- A persisted head fingerprint records its byte length; later comparisons first hash that exact prefix so ordinary appends cannot look like file replacement, then may safely expand the stored prefix after continuity is proven.
- Daily incremental deduplication persists only the last event fingerprint per rollout; full rebuilds keep a temporary global fingerprint set in memory.
- A rebuild never applies `data.historyDays`; existing retention cleanup remains responsible for later pruning.
- The startup migration keeps old usage visible and pauses Codex usage writes while its shadow rebuild runs.
- Shadow scan or commit failure must leave `usageDaily`, the old cursor, and the migration marker unchanged.
- Migration failure resumes legacy active-root scanning for the current process and retries on the next launch.
- A post-commit catch-up failure never enters legacy mode: once the UUID cursor and migration marker are committed, later polls must remain in UUID mode and retry the unread tail.
- A successful commit replaces only `codex:*`, `localLogCursors.codex`, and `localLogMigrations.codexArchiveUuidCursorV1` through one `store.store = nextStore` assignment.
- DeepSeek and Kimi behavior, data, cursors, and migrations must not change.
- Do not modify, move, delete, or rewrite rollout files.
- Do not add a database or a permanent event ledger.
- Implement every behavior test-first and commit each task separately before moving on.

---

## File Structure

- Modify `src/main/core/locallog.js`: add explicit scan completion metadata and a reusable chunked snapshot primitive without changing Kimi path identity.
- Modify `src/main/providers/codex/locallog.js`: parse event fingerprints, resolve active/archive roots, select candidates by stable rollout identity, and expose legacy and UUID scan modes.
- Modify `src/main/providers/codex/index.js`: expose the dual-root configuration and route reads through the runtime coordinator when injected.
- Create `src/main/providers/codex/rebuild.js`: own shadow state, global event deduplication, completion-driven rebuild loops, Codex-only snapshot replacement, and migration constants.
- Create `src/main/providers/codex/runtime.js`: own the unique migration/rebuild Promise, startup state, exclusive Codex operations, and legacy failure fallback.
- Create `src/main/core/codex-usage-bootstrap.js`: start migration before scheduler construction without awaiting it, so the scheduler's initial Codex poll is queued behind migration.
- Modify `src/main/core/scheduler.js`: allow Codex local-log polls to pass through an injected provider coordinator without affecting other channels.
- Modify `src/main/core/history-sync.js`: keep generic Kimi rescan behavior, but require explicit completion rather than empty-record termination.
- Modify `src/main/ipc.js`: delegate Codex history sync to the safe shadow rebuild and keep Kimi on generic rescan.
- Modify `src/main/index.js`: construct the Codex runtime, start migration in the background, inject it into scheduler/IPC, and stop it during quit.
- Modify `src/main/core/settings-reset.js`: retain the Codex migration marker together with its UUID cursor and aggregate.
- Modify `src/main/providers/types.js` and `scripts/verify-locallog.js`: document and consume the `ScanBatch` result.
- Extend focused scanner, scheduler, history-sync, IPC, settings-reset, and startup tests.
- Create `test/codex-archive-locallog.test.js`: real-filesystem tests for UUID identity, moving files, dual candidates, replacement, and event fingerprints.
- Create `test/codex-usage-rebuild.test.js`: shadow rebuild and atomic store snapshot tests.
- Create `test/codex-usage-runtime.test.js`: startup migration, operation serialization, fallback, and retry tests.
- Create `scripts/verify-codex-archive-usage.js`: read-only local acceptance script for static historical days; it must never write store state.

---

### Task 1: Explicit Scan Completion Without Breaking Kimi

**Files:**
- Modify: `src/main/core/locallog.js`
- Modify: `src/main/providers/codex/locallog.js`
- Modify: `src/main/providers/kimi/locallog.js`
- Modify: `src/main/providers/types.js`
- Modify: `src/main/core/scheduler.js`
- Modify: `src/main/core/history-sync.js`
- Modify: `scripts/verify-locallog.js`
- Modify: `test/locallog.test.js`
- Modify: `test/locallog-chunked-scan.test.js`
- Modify: `test/locallog-chunked-recovery.test.js`
- Modify: `test/locallog-retain-all.test.js`
- Modify: `test/locallog-invalid-timestamp.test.js`
- Modify: `test/locallog-stable-evaluation-time.test.js`
- Modify: `test/history-sync.test.js`
- Modify: `test/settings-reset-codex-data-integrity.test.js`
- Modify: `test/settings-reset-kimi-history-integrity.test.js`

**Interfaces:**
- Produces `scanFileBatch(options): Promise<ScanBatch>` where `ScanBatch` is `{ records: UsageRecord[], complete: boolean, bytesRead: number }`.
- Keeps `scanFiles(options): Promise<UsageRecord[]>` as a compatibility wrapper for existing single-directory callers during this task.
- Changes Codex and Kimi `readLocalLog(ctx, opts)` to resolve a `ScanBatch`; scheduler change detection reads `batch.records`.
- Changes `rescanLocalLogs(options)` to stop only when `batch.complete === true` and return `{ daysRebuilt, earliestDate, passes, records, bytesRead }`.
- Raises an error with `code === 'LOCAL_LOG_RESCAN_INCOMPLETE'` if an injectable pass limit is exhausted before `complete`.

- [ ] **Step 1: Write failing `ScanBatch` tests**

Add tests in `test/locallog-chunked-scan.test.js` that call the new wished-for API directly:

```js
const { scanFileBatch } = require('../src/main/core/locallog');

test('scanFileBatch reports incomplete when the byte budget leaves readable bytes', async () => {
  const first = await scanFixtureBatch(dir, cursorStore, {
    chunkBytes: 31,
    maxBytesPerScan: 93
  });

  assert.ok(first.records.length > 0);
  assert.equal(first.complete, false);
  assert.ok(first.bytesRead >= 93);

  let last = first;
  while (!last.complete) {
    last = await scanFixtureBatch(dir, cursorStore, {
      chunkBytes: 31,
      maxBytesPerScan: 93
    });
  }
  assert.equal(last.complete, true);
});
```

Add a real file whose first budget contains only non-usage JSONL rows. Assert `records.length === 0`, `bytesRead > 0`, and `complete === false`. Add a missing-root case expecting `{ records: [], complete: true, bytesRead: 0 }`.

- [ ] **Step 2: Write failing completion-driven rescan tests**

Replace the two existing rescan test doubles with `ScanBatch` results. Add this regression:

```js
test('rescan continues through empty incomplete batches', async () => {
  const batches = [
    { records: [], complete: false, bytesRead: 100 },
    { records: [{ provider: 'codex' }], complete: false, bytesRead: 100 },
    { records: [], complete: true, bytesRead: 0 }
  ];
  const result = await rescanLocalLogs({
    providerId: 'codex',
    readLocalLog: async () => batches.shift(),
    readStore: store.get,
    writeStore: store.set
  });
  assert.equal(result.passes, 3);
  assert.equal(result.records, 1);
  assert.equal(result.bytesRead, 200);
});
```

Add a `maxPasses: 2` case with two incomplete batches. Expect `LOCAL_LOG_RESCAN_INCOMPLETE` and verify the provider rows and cursor are restored while another provider row remains byte-for-byte equal.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
node --test test/locallog.test.js test/locallog-chunked-scan.test.js test/locallog-chunked-recovery.test.js test/history-sync.test.js
```

Expected: FAIL because `scanFileBatch` does not exist and rescan still stops on an empty array.

- [ ] **Step 4: Extract `scanFileBatch` from the current scanner**

Move the current implementation body into `scanFileBatch`. Track `bytesRead` by adding each successful `result.bytesRead`. Compute `complete` against the scan-start file snapshot:

- initialize `complete = true`;
- set `complete = false` when the global budget prevents visiting a remaining file;
- set `complete = false` when a visited file still has complete unread bytes after the committed offset;
- a trailing partial line without a newline stays uncommitted but does not by itself force `complete=false` after the file snapshot is fully visited;
- return a complete empty batch for a missing root.

Implement the compatibility wrapper exactly as:

```js
async function scanFiles(options) {
  return (await scanFileBatch(options)).records;
}
```

Export both functions.

- [ ] **Step 5: Change provider reads and scheduler to `ScanBatch`**

Codex and Kimi call `scanFileBatch`, aggregate `batch.records`, and return the unchanged batch object. In `pollLocalLog`, normalize legacy test doubles temporarily:

```js
const batch = await provider.readLocalLog(ctxFor(provider));
const records = Array.isArray(batch) ? batch : batch.records;
const changed = Array.isArray(records) && records.length > 0;
```

Update `scripts/verify-locallog.js`, provider type comments, and all direct provider-read tests to assert `batch.records` and `batch.complete`.

- [ ] **Step 6: Make generic rescan completion-driven and transactional**

Before clearing data, deep-clone matching provider rows and `localLogCursors.<provider>`. Loop on `complete`, not record count. Accumulate `bytesRead`. Use a production default of `MAX_SCAN_PASSES = 10000`; on exhaustion create:

```js
const error = new Error(`Local log rescan incomplete for ${providerId}`);
error.code = 'LOCAL_LOG_RESCAN_INCOMPLETE';
error.providerId = providerId;
error.passes = passes;
error.bytesRead = bytesRead;
```

On any error, delete the partial provider rows, restore the cloned rows and cursor, and rethrow. This generic path remains for Kimi; Codex will move to shadow rebuild in Task 4.

- [ ] **Step 7: Run all affected tests and verify GREEN**

Run:

```powershell
node --test test/locallog*.test.js test/history-sync.test.js test/scheduler-locallog-broadcast.test.js test/settings-reset-codex-data-integrity.test.js test/settings-reset-kimi-history-integrity.test.js
```

Expected: all selected tests PASS.

- [ ] **Step 8: Commit the scan protocol**

```powershell
git add src/main/core/locallog.js src/main/providers/codex/locallog.js src/main/providers/kimi/locallog.js src/main/providers/types.js src/main/core/scheduler.js src/main/core/history-sync.js scripts/verify-locallog.js test/locallog.test.js test/locallog-chunked-scan.test.js test/locallog-chunked-recovery.test.js test/locallog-retain-all.test.js test/locallog-invalid-timestamp.test.js test/locallog-stable-evaluation-time.test.js test/history-sync.test.js test/settings-reset-codex-data-integrity.test.js test/settings-reset-kimi-history-integrity.test.js
git commit -m "fix: report local-log scan completion"
```

---

### Task 2: Codex Stable Identity and Event Fingerprints

**Files:**
- Modify: `src/main/providers/codex/locallog.js`
- Create: `test/codex-archive-locallog.test.js`
- Modify: `test/locallog.test.js`

**Interfaces:**
- Produces `rolloutIdentity(filePath): string`.
- Produces `codexEventFingerprint(record): string | null`.
- Extends `parseRolloutLine` records with `eventFingerprint` computed from normalized timestamp and `last_token_usage` fields.
- Produces `resolveCodexLogRoots(store): { activeRoot: string, archiveRoot: string | null }`.
- Exports `DEFAULT_ROOT()` unchanged and adds `DEFAULT_ARCHIVE_ROOT()`.

- [ ] **Step 1: Write failing rollout identity tests**

Create `test/codex-archive-locallog.test.js` with literal Windows and POSIX paths:

```js
test('rolloutIdentity extracts the terminal UUID independent of path', () => {
  const name = 'rollout-2026-08-09T19-01-47-019fe62f-9a3c-7cb2-9e34-f21173cf257d.jsonl';
  assert.equal(rolloutIdentity('C:\\a\\' + name), '019fe62f-9a3c-7cb2-9e34-f21173cf257d');
  assert.equal(rolloutIdentity('/b/' + name), '019fe62f-9a3c-7cb2-9e34-f21173cf257d');
});

test('rolloutIdentity falls back to basename for nonstandard rollouts', () => {
  assert.equal(rolloutIdentity('/a/rollout-private-fixture.jsonl'), 'rollout-private-fixture.jsonl');
});
```

- [ ] **Step 2: Write failing fingerprint normalization tests**

Construct two `token_count` lines with the same timestamp and `last_token_usage`, but different `rate_limits` and `total_token_usage`. Assert equal non-null `eventFingerprint`. Change `output_tokens` by one and assert the fingerprint changes. Assert malformed/non-usage lines still return `null` from `parseRolloutLine`.

Use this canonical material, with absent numeric fields normalized to zero:

```js
[
  new Date(ts).toISOString(),
  input,
  cached,
  output,
  reasoning,
  total
].join('\0')
```

- [ ] **Step 3: Write failing root-resolution tests**

Assert these exact cases:

- no custom setting -> default active plus default archive;
- custom active only -> custom active plus `archiveRoot: null`;
- custom active and custom archive -> both custom paths;
- default active plus explicit custom archive -> default active plus custom archive.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```powershell
node --test test/codex-archive-locallog.test.js test/locallog.test.js
```

Expected: FAIL because the identity, fingerprint, archive root, and resolver exports do not exist.

- [ ] **Step 5: Implement pure identity, root, and fingerprint helpers**

Import `node:crypto`. Keep the helpers pure. Use a strict terminal UUID pattern:

```js
const ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
```

Normalize both Windows and POSIX separators before taking the basename:

```js
const basename = path.posix.basename(String(filePath).replace(/\\/g, '/'));
```

Compute `sha256:` plus the lowercase hex digest of canonical material. `parseRolloutLine` returns the existing `ts`/`usage` plus `eventFingerprint`. Do not include path, cumulative totals, rate limits, model, or mutable metadata.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run the Step 4 command. Expected: all tests PASS.

- [ ] **Step 7: Commit the pure Codex primitives**

```powershell
git add src/main/providers/codex/locallog.js test/codex-archive-locallog.test.js test/locallog.test.js
git commit -m "feat: identify Codex rollouts and usage events"
```

---

### Task 3: Dual-Root UUID Cursor Scanner

**Files:**
- Modify: `src/main/core/locallog.js`
- Modify: `src/main/providers/codex/locallog.js`
- Modify: `src/main/providers/codex/index.js`
- Modify: `test/codex-archive-locallog.test.js`
- Modify: `test/locallog-chunked-scan.test.js`
- Modify: `test/settings-reset-codex-data-integrity.test.js`

**Interfaces:**
- Produces `scanCodexLogBatch({ store, mode, diagnostics, nowMs, chunkBytes, maxBytesPerScan, yieldToLoop, seenFingerprints }): Promise<ScanBatch>`.
- `scanCodexLogBatch` mutates only the selected cursor store and returns records; provider `readLocalLog` remains the layer that rolls records into `usageDaily`.
- `mode === 'legacy'` uses the current active-root path cursor behavior.
- `mode === 'uuid'` enumerates active/archive roots and persists UUID cursor values:

```js
{
  offset: number,
  mtimeMs: number,
  size: number,
  headBytes: number,
  headFingerprint: string,
  lastEventFingerprint: string | null
}
```

- Produces internal/test-exported `collectRolloutCandidates(roots)` and `selectRolloutCandidate(identity, candidates, cursor)`.
- Adds a generic `scanCandidateBatch(options)` primitive in `core/locallog.js`; it consumes caller-provided `{ identity, filePath }` candidates and caller-provided cursor transition hooks.

- [ ] **Step 1: Write the failing move regression**

Use temporary sibling `sessions` and `archived_sessions` directories. Write two complete usage lines to one standard rollout file. Scan with a budget that commits only the first line, move the file into the archive directory without changing its basename, scan again, and assert:

```js
assert.deepEqual(first.records.map((r) => r.usage.total), [10]);
assert.deepEqual(second.records.map((r) => r.usage.total), [20]);
assert.equal(Object.keys(store.get('localLogCursors.codex'))[0], rolloutUuid);
```

This test must fail against the current path-key scanner by returning no second event or replaying the first.

- [ ] **Step 2: Write failing dual-candidate and selection tests**

Cover these real filesystem cases separately:

- the same file copied into both roots is scanned once;
- archive candidate is larger and can carry the existing offset, so its tail is selected;
- equal-size candidates select active deterministically;
- an existing cursor offset larger than one candidate excludes that candidate;
- when one candidate matches the cursor's stored head and another larger candidate conflicts, the matching candidate is the continuation and the conflict is counted diagnostically;
- a cursor identity absent from both fully enumerated roots is removed only after enumeration completes.

- [ ] **Step 3: Write failing replacement and boundary-dedupe tests**

Add a file-head fingerprint test: fully scan one file, replace it with another file under the same UUID and a different head, and assert scanning restarts at zero. Add an append regression where the original file is shorter than 4096 bytes, then grows beyond its original length; assert the old prefix is compared first, the cursor continues rather than resetting, and `headBytes` may then expand to cover the larger stable prefix. Add adjacent duplicate event lines split across scan batches; the second batch must advance offset but emit no record because `lastEventFingerprint` matches.

Add an optional `seenFingerprints` Set test: place the same event non-adjacently and assert a full-rebuild scan emits it once while an ordinary incremental scan only suppresses adjacent/cross-batch duplicates.

- [ ] **Step 4: Write the open-after-move retry test**

Inject an `openCandidate` test hook. On its first invocation, rename the selected active file into archive and throw `ENOENT`. Assert the scanner recollects candidates for that UUID once, opens the archive path, and returns the record without resetting or deleting the UUID cursor.

- [ ] **Step 5: Run the focused tests and verify RED**

Run:

```powershell
node --test test/codex-archive-locallog.test.js test/locallog-chunked-scan.test.js test/settings-reset-codex-data-integrity.test.js
```

Expected: move, candidate, replacement, and dedupe tests FAIL because only one path root and path-key cursors exist.

- [ ] **Step 6: Extract the generic candidate scanner**

Refactor the chunk-reading loop once; do not duplicate it in the provider. `scanCandidateBatch` must:

- receive a sorted candidate snapshot;
- get/set cursor state through injected callbacks;
- commit the cursor only after each complete newline;
- count `bytesRead` and return `complete` under the same rules as Task 1;
- invoke `onRecord({ record, cursor, identity })` to decide emit/skip and return the next cursor metadata;
- invoke `resetCursor(cursor, stat, { headBytes, headFingerprint })` when size/head proves replacement;
- preserve parser-failure recovery semantics from `test/locallog-chunked-recovery.test.js`.

Keep the legacy `scanFileBatch` wrapper built on this primitive so Kimi behavior remains unchanged.

- [ ] **Step 7: Implement Codex candidate enumeration and UUID cursors**

Enumerate both roots with `walkFiles`, group by `rolloutIdentity`, stat candidates, and sort by identity. For a new non-empty identity, persist `headBytes = min(4096, size)` and hash exactly that prefix. For an existing cursor, first hash exactly its persisted `headBytes` for each candidate. After a continuation candidate matches, it is safe to expand to `min(4096, size)` and replace both stored head fields; never compare a newly expanded prefix against an older shorter-prefix digest. An empty file keeps `headBytes = 0` and no effective fingerprint until content first appears.

Candidate selection is explicit:

1. first form the continuation set: candidates with `size >= cursor.offset` whose exact prefix matches the stored fingerprint;
2. if the continuation set is non-empty, choose its largest candidate, then active before archive, then lexical path;
3. if it is empty, record the safe head/size conflict diagnostic, choose deterministically by ability to carry the old offset, largest size, active before archive, then lexical path, and reset the selected replacement to offset zero;
4. with no cursor, choose largest size, then active before archive, then lexical path.

When a selected candidate disappears before open, recollect only that identity once. Cursor cleanup uses the complete union of identities, never a single root.

For each parsed usage record:

- if `seenFingerprints` contains `eventFingerprint`, increment `diagnostics.duplicateEvent`, skip emission, and still commit offset;
- otherwise add it to `seenFingerprints` when supplied;
- else if it equals cursor `lastEventFingerprint`, increment `diagnostics.duplicateEvent` and skip emission;
- otherwise emit it;
- always set `lastEventFingerprint` to the valid current event fingerprint.

- [ ] **Step 8: Route Codex reads by explicit mode**

`readLocalLog(ctx, opts)` selects `opts.mode` when present. Otherwise it uses UUID mode only when `localLogMigrations.codexArchiveUuidCursorV1 === true`; missing marker uses legacy mode. Update `codex/index.js` so `localLogRoot()` remains the active root for the existing watcher and add `archivedLogRoot(ctx)` for diagnostics/future watchers; correctness still comes from scheduled joint scans.

- [ ] **Step 9: Run the focused tests and verify GREEN**

Run the Step 5 command plus recovery tests:

```powershell
node --test test/codex-archive-locallog.test.js test/locallog-chunked-scan.test.js test/locallog-chunked-recovery.test.js test/settings-reset-codex-data-integrity.test.js
```

Expected: all selected tests PASS.

- [ ] **Step 10: Commit the dual-root scanner**

```powershell
git add src/main/core/locallog.js src/main/providers/codex/locallog.js src/main/providers/codex/index.js test/codex-archive-locallog.test.js test/locallog-chunked-scan.test.js test/settings-reset-codex-data-integrity.test.js
git commit -m "fix: follow Codex rollouts into archive"
```

---

### Task 4: Transactional Shadow Rebuild

**Files:**
- Create: `src/main/providers/codex/rebuild.js`
- Create: `test/codex-usage-rebuild.test.js`
- Modify: `src/main/providers/codex/locallog.js`

**Interfaces:**
- Exports `CODEX_ARCHIVE_MIGRATION_KEY = 'localLogMigrations.codexArchiveUuidCursorV1'`.
- Exports `buildCodexShadow({ activeRoot, archiveRoot, nowMs, chunkBytes, maxBytesPerScan, maxPasses, scanBatch, onProgress }): Promise<{ usageDaily, cursors, summary }>`.
- Exports `replaceCodexSnapshot(store, shadow): void`.
- Exports `rebuildCodexUsage({ store, ...buildOptions }): Promise<summary>` as build-then-commit composition.
- `summary` is `{ daysRebuilt, earliestDate, passes, records, duplicates, bytesRead }`; `duplicates` is the final `diagnostics.duplicateEvent || 0` count.

- [ ] **Step 1: Write failing full-rebuild dedupe tests**

Create two temporary roots with:

- one active file containing events A, B, duplicate A;
- one archived file containing duplicate B and event C;
- at least two dates;
- a small byte budget forcing several passes.

Call `buildCodexShadow` and assert exact daily `input`, `cached`, `output`, and `total` sums count A/B/C once. Assert `duplicates === 2`, `complete` was reached after more than one pass, and the final cursors point to EOF.

Make one date older than a seeded `data.historyDays: 7` value and assert it is still present in the shadow result; rebuild deliberately ignores retention.

- [ ] **Step 2: Write failing static idempotence test**

Run `buildCodexShadow` twice against the same roots with fresh shadow state. Assert deep equality of `usageDaily`, `cursors`, and all summary fields except elapsed timing (no timing field should be added).

- [ ] **Step 3: Write failing Codex-only snapshot replacement test**

Use a fake store exposing a `store` getter/setter that clones assignments and counts writes. Seed it with Codex, DeepSeek, Kimi, settings, legacy cursor, and Kimi migration state. Call `replaceCodexSnapshot` and assert:

- exactly one `store` assignment occurred;
- old `codex:*` rows were removed and shadow rows inserted;
- all non-Codex content remains deep-equal;
- `localLogCursors.codex` equals the UUID cursor map;
- migration marker is `true`.

- [ ] **Step 4: Write failing scan/commit failure tests**

Inject a `scanBatch` that throws on pass 2 and assert the real store setter was never invoked. Inject a store setter that throws and assert the original backing snapshot remains unchanged in the fake. The rebuild error must propagate with no rollout content or full path added to its message.

- [ ] **Step 5: Run focused tests and verify RED**

Run:

```powershell
node --test test/codex-usage-rebuild.test.js test/codex-archive-locallog.test.js
```

Expected: FAIL because the rebuild module does not exist.

- [ ] **Step 6: Implement an in-memory shadow store**

Inside `buildCodexShadow`, create a minimal store with dot-key `get/set`, initially:

```js
{
  usageDaily: {},
  'localLogCursors.codex': {},
  'localLogMigrations.codexArchiveUuidCursorV1': true,
  'providers.codex.localLogRoot': activeRoot,
  'providers.codex.archivedLogRoot': archiveRoot
}
```

Use one `seenFingerprints = new Set()` and one `diagnostics = {}` for all passes and candidates. Call `scanCodexLogBatch` with `mode: 'uuid'`, the set, and diagnostics. Merge `rollupDaily(batch.records, diagnostics, nowMs)` into shadow `usageDaily`; never call the live store. Continue until `complete`. Use `MAX_CODEX_REBUILD_PASSES = 10000` and throw `LOCAL_LOG_RESCAN_INCOMPLETE` with only safe counters if exhausted.

- [ ] **Step 7: Implement a single-snapshot Codex replacement**

At commit time, clone the current `store.store`, not a snapshot captured before scanning. Remove only top-level `usageDaily` entries with prefix `codex:`; preserve all other rows. Set nested cursor and migration marker fields on the cloned object, then make exactly one assignment:

```js
store.store = nextStore;
```

Do not call `store.set()` before or after this assignment for any part of the Codex commit.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run the Step 5 command. Expected: all selected tests PASS.

- [ ] **Step 9: Commit the shadow rebuild**

```powershell
git add src/main/providers/codex/rebuild.js src/main/providers/codex/locallog.js test/codex-usage-rebuild.test.js
git commit -m "fix: rebuild Codex usage transactionally"
```

---

### Task 5: Codex Runtime Coordinator and Failure Fallback

**Files:**
- Create: `src/main/providers/codex/runtime.js`
- Create: `test/codex-usage-runtime.test.js`
- Modify: `src/main/providers/codex/index.js`
- Modify: `src/main/core/scheduler.js`
- Modify: `test/scheduler.test.js`
- Modify: `test/scheduler-locallog-broadcast.test.js`

**Interfaces:**
- Exports `createCodexUsageRuntime(options)`.
- Runtime methods:

```js
{
  startMigration(): Promise<MigrationResult>,
  runIncremental(fn): Promise<unknown>,
  rebuild(options): Promise<RebuildSummary>,
  getStatus(): { phase, migrationPending, compatibilityMode, lastErrorCode },
  stop(): void
}
```

- `phase` is one of `'idle'`, `'migrating'`, `'ready'`, `'compatibility'`, `'stopped'`.
- All Codex write operations use one FIFO Promise tail; Kimi and other scheduler channels do not.
- `MigrationResult` is `{ migrated: boolean, skipped: boolean, summary?: RebuildSummary, errorCode?: string, catchUpErrorCode?: string }`; pre-commit migration failure resolves with a safe result rather than rejecting startup.
- While `migrationPending === true`, `rebuild()` awaits the existing startup `migrationPromise` instead of queueing a second full rebuild, then returns its `summary` or throws a safe coded error when that migration failed before commit.
- While `phase === 'compatibility'`, `rebuild()` performs a new shadow rebuild; success transitions to `ready`, while failure keeps compatibility mode and the migration marker absent.

- [ ] **Step 1: Write failing unique-migration Promise tests**

Use a deferred rebuild function. Call `startMigration()` twice before release and assert `strictEqual(firstPromise, secondPromise)`, the injected rebuild runs once, and both calls resolve to the same result. Seed the marker `true` and assert `phase` changes to `ready` synchronously, `migrationPending` remains false, and rebuild is skipped without invocation.

- [ ] **Step 2: Write failing pause/serialization tests**

Seed an old `codex:*` value, start a blocked migration, then call two `runIncremental` functions. Assert the old value remains readable and neither incremental starts while migration is active. Release migration and assert the incrementals run FIFO and receive UUID mode. Repeat with a failed migration and assert the queued incremental chooses legacy mode only when its queued operation actually starts. Start a manual `rebuild()` and an incremental simultaneously; assert max active Codex writer is 1.

- [ ] **Step 3: Write failing compatibility fallback tests**

Inject a rebuild failure. Assert:

- startup migration resolves `{ migrated: false, errorCode: safeCode }`;
- runtime phase becomes `compatibility`;
- a later `runIncremental` executes with `{ mode: 'legacy' }` supplied by runtime;
- the marker remains missing;
- a newly constructed runtime on the next simulated launch invokes migration again.

Then call manual `rebuild()` while in compatibility mode. Cover both outcomes: a successful retry commits the marker, runs one UUID catch-up, and moves to `ready`; a failed retry leaves the runtime in compatibility mode and propagates a safe rebuild error to the manual caller.

- [ ] **Step 4: Write failing successful post-commit catch-up test**

Inject `rebuildCodexUsage` and `incrementalScan`. Assert successful migration calls rebuild once, then runs exactly one UUID incremental catch-up, then enters `ready`. The catch-up must execute after the migration marker exists.

Add a catch-up failure case. Seed `rebuildCodexUsage` so it commits the marker, then make `incrementalScan` throw. Assert the result is still `migrated: true` with `catchUpErrorCode`, phase is `ready`, and the next `runIncremental` receives `{ mode: 'uuid' }`. Assert it never enters compatibility/legacy mode.

- [ ] **Step 5: Run focused tests and verify RED**

Run:

```powershell
node --test test/codex-usage-runtime.test.js test/scheduler.test.js test/scheduler-locallog-broadcast.test.js
```

Expected: FAIL because the runtime module and scheduler injection do not exist.

- [ ] **Step 6: Implement the FIFO runtime coordinator**

Use a private `tail = Promise.resolve()` and an `enqueue(operation)` function that chains after `tail`, updates `tail` to a rejection-swallowing completion Promise for queue continuity, and returns the real operation Promise. `startMigration()` must return the stored Promise directly rather than being declared `async`, so repeated calls preserve Promise identity. Keep `migrationPromise` for the runtime lifetime and track the active interval separately with `migrationPending`; choose UUID/legacy options inside each queued incremental operation, not when it is enqueued.

Implement `rebuild()` with explicit state rules before generic queueing:

```js
if (migrationPending && migrationPromise) {
  const result = await migrationPromise;
  if (result.summary) return result.summary;
  throw safeMigrationError(result.errorCode);
}
if (phase === 'stopped') throw stoppedError();
return enqueue(() => runShadowRebuildAndCatchUp({ rejectOnFailure: true }));
```

The shared `runShadowRebuildAndCatchUp` helper must distinguish the commit boundary. A shadow scan or `store.store` failure occurs before a migration marker exists: startup enters compatibility mode, while manual retry keeps compatibility mode and throws a safe coded error. Once `rebuildCodexUsage` returns, commit succeeded: set phase to `ready` before attempting UUID catch-up. Catch-up failure records `catchUpErrorCode` but keeps `ready`; the scheduler's next UUID scan retries from the committed cursor.

On failure, map the error to a safe code using `error.code` only when it matches `/^[A-Z][A-Z0-9_:-]{0,63}$/`; otherwise use `CODEX_ARCHIVE_MIGRATION_FAILED`. Do not log raw messages or paths. `stop()` prevents new queued operations but lets the current operation settle.

- [ ] **Step 7: Route scheduler Codex polls through the runtime**

Add optional `codexUsageRuntime` to `startScheduler`. In `pollLocalLog`, for provider `codex`, execute the direct provider read through:

```js
codexUsageRuntime.runIncremental((scanOptions) =>
  provider.readLocalLog(ctxFor(provider), scanOptions)
)
```

Other providers call `provider.readLocalLog` exactly as before. Keep scheduler `inflight` coalescing to prevent timer duplicates; runtime handles cross-source Codex serialization.

- [ ] **Step 8: Run focused tests and verify GREEN**

Run the Step 5 command. Expected: all selected tests PASS.

- [ ] **Step 9: Commit the runtime coordinator**

```powershell
git add src/main/providers/codex/runtime.js src/main/providers/codex/index.js src/main/core/scheduler.js test/codex-usage-runtime.test.js test/scheduler.test.js test/scheduler-locallog-broadcast.test.js
git commit -m "fix: coordinate Codex usage migration"
```

---

### Task 6: Startup, Manual History Sync, and Settings Integration

**Files:**
- Create: `src/main/core/codex-usage-bootstrap.js`
- Modify: `src/main/index.js`
- Modify: `src/main/ipc.js`
- Modify: `src/main/core/settings-reset.js`
- Modify: `test/history-sync-ipc.test.js`
- Modify: `test/settings-reset-codex-data-integrity.test.js`
- Create: `test/codex-usage-startup.test.js`
- Modify: `test/diagnostics-integration.test.js`

**Interfaces:**
- `setupIPC(deps)` receives `codexUsageRuntime`.
- Codex `sync:history` uses `codexUsageRuntime.rebuild({ onProgress })`.
- Kimi `sync:history` continues to use `rescanLocalLogs`.
- `startSchedulerRuntime()` passes `codexUsageRuntime` into the scheduler.
- `startCodexUsageBootstrap({ createRuntime, startScheduler, onUnexpectedMigrationError })` returns `{ runtime, scheduler, migrationPromise }`.
- Startup creates the runtime, calls `startMigration()` without awaiting it, then constructs the scheduler with that runtime.

- [ ] **Step 1: Write failing startup-order tests**

In `test/codex-usage-startup.test.js`, import the pure `startCodexUsageBootstrap` helper from `src/main/core/codex-usage-bootstrap.js` and inject fakes. Assert observable order:

1. runtime constructed;
2. migration started and its Promise captured without awaiting;
3. scheduler constructed with that runtime;
4. app-ready continuation does not wait for migration resolution.

Use a never-resolving migration Promise and assert the startup composition function still returns scheduler/runtime handles.

- [ ] **Step 2: Write failing manual-sync routing tests**

Replace the source-text-only Codex assertion in `test/history-sync-ipc.test.js` with an invoked IPC handler harness. Assert:

- Codex summary comes from `codexUsageRuntime.rebuild`;
- Kimi summary comes from generic `rescanLocalLogs`/provider reads;
- when migration is already running, runtime reuse prevents a second Codex rebuild;
- progress callback reaches `sync:progress`;
- `pollAll()` runs after both paths complete.

- [ ] **Step 3: Write failing settings-reset durability test**

Seed `usageDaily`, UUID cursor, `localLogMigrations.codexArchiveUuidCursorV1: true`, and unrelated settings. Reset twice. Assert aggregate, cursor, and marker survive together; repeated UUID `readLocalLog` emits zero old records.

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```powershell
node --test test/codex-usage-startup.test.js test/history-sync-ipc.test.js test/settings-reset-codex-data-integrity.test.js test/diagnostics-integration.test.js
```

Expected: startup/manual-sync/marker assertions FAIL because runtime is not wired.

- [ ] **Step 5: Wire runtime into application startup**

Implement `startCodexUsageBootstrap` as a synchronous composition helper: call `createRuntime()`, immediately call `runtime.startMigration()`, attach a rejection handler that reports only the constant `CODEX_USAGE_BOOTSTRAP_FAILED`, then call `startScheduler(runtime)`. Return all three handles without awaiting the migration Promise.

In `index.js`, invoke this helper after provider registration. `createRuntime` injects:

- real store;
- `rebuildCodexUsage`;
- an incremental callback that calls Codex provider with explicit UUID/legacy mode;
- a safe logger that logs `{ code, phase }` only;
- a broadcast callback that notifies `providers:changed` after successful catch-up.

Pass `startSchedulerRuntime(codexUsageRuntime)` as the helper's `startScheduler` callback, retain the returned runtime/scheduler handles, and continue app readiness immediately. The runtime normally resolves expected failures safely; the helper's terminal rejection callback prevents an unexpected programmer error from becoming an unhandled rejection without logging raw messages or paths. Call `codexUsageRuntime.stop()` during `before-quit`.

- [ ] **Step 6: Route manual Codex history sync to the runtime**

Handle Codex separately from the existing Kimi loop:

```js
summary.codex = deps.codexUsageRuntime
  ? await deps.codexUsageRuntime.rebuild({ onProgress: sendProgress })
  : await rescanLocalLogs(/* compatibility test harness */);
```

Keep Kimi on the generic transactional rescan. Preserve DeepSeek ordering, retention hint, token-speed rebaseline, and final `pollAll()`.

- [ ] **Step 7: Preserve the migration marker during settings reset**

Add `localLogMigrations.codexArchiveUuidCursorV1` to `RESET_KEEP_KEYS`, adjacent to the Codex cursor. Update comments to state that aggregate, compatible cursor, and completed migration version are one durable unit.

- [ ] **Step 8: Update diagnostics read guards**

Diagnostics must remain read-only and must not trigger migration or read cursor details. Update integration expectations only where new injected runtime dependencies affect harness construction; do not expose UUIDs, paths, event fingerprints, or migration errors containing raw messages.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run the Step 4 command. Expected: all selected tests PASS.

- [ ] **Step 10: Commit application integration**

```powershell
git add src/main/core/codex-usage-bootstrap.js src/main/index.js src/main/ipc.js src/main/core/settings-reset.js test/codex-usage-startup.test.js test/history-sync-ipc.test.js test/settings-reset-codex-data-integrity.test.js test/diagnostics-integration.test.js
git commit -m "fix: run Codex archive migration on startup"
```

---

### Task 7: Read-Only Local Acceptance and Full Verification

**Files:**
- Create: `scripts/verify-codex-archive-usage.js`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `docs/diagnostics/codex-local-log.md`
- Modify: `test/codex-usage-rebuild.test.js`
- Modify: `test/codex-archive-locallog.test.js`

**Interfaces:**
- Adds `npm run verify:codex-archive-usage -- --date YYYY-MM-DD`.
- Script reads rollout files and optionally compares a caller-injected/plain read-only store projection; it must not initialize `electron-store`, call `initializeStore`, create recovery backups, invoke `set`, assign `store.store`, or mutate source files.
- Script emits only per-day aggregate numbers, counts, and pass/fail status; never prints rollout contents, UUIDs, or full private paths.

- [ ] **Step 1: Write the read-only verifier as a testable module**

Export `verifyCodexArchiveUsage(options)` and guard CLI execution with `require.main === module`. Inject roots and a read-only store projection in tests. Return:

```js
{
  files,
  uniqueEvents,
  duplicateEvents,
  daily,
  comparedStoreDaily
}
```

Add a test store whose `set`, `delete`, and `store` setter throw `STORE_MUTATION`. Run verification and assert no mutation exception and exact totals from temporary roots.

For the CLI, omit store comparison unless the caller supplies a separate already-decrypted JSON projection through an explicit `--store-projection <path>` option. Parse that projection with `fs.readFile` only. Never accept the live encrypted `config.json` as this option, never read `.key`, and never add decryption logic to the verifier.

- [ ] **Step 2: Run verifier tests and verify RED/GREEN**

Before implementation, add the test to `test/codex-usage-rebuild.test.js` and run:

```powershell
node --test test/codex-usage-rebuild.test.js
```

Expected RED: module missing. Implement the verifier by calling the read-only `buildCodexShadow` phase with injected roots (never `rebuildCodexUsage`, which commits), then project the requested date and optional comparison data. Rerun and expect PASS.

- [ ] **Step 3: Add package command and documentation**

Add:

```json
"verify:codex-archive-usage": "node scripts/verify-codex-archive-usage.js"
```

Document that upgrade migration is automatic and transactional, old usage stays visible while it runs, failure retries next launch, custom archive roots require explicit configuration, and the verifier is read-only.

- [ ] **Step 4: Run the complete Node test suite**

Run:

```powershell
npm test
```

Expected: exit code 0 and zero failed tests. Record the exact test/pass counts in the handoff.

- [ ] **Step 5: Build the renderer**

Run:

```powershell
npm run build:renderer
```

Expected: Vite exits 0 without import or syntax errors.

- [ ] **Step 6: Run the read-only local historical verification**

Ensure the application is not writing the store during the comparison, then run the verifier without any mutation flag:

```powershell
npm run verify:codex-archive-usage -- --date 2026-07-23
npm run verify:codex-archive-usage -- --date 2026-08-09
npm run verify:codex-archive-usage -- --date 2026-08-10
npm run verify:codex-archive-usage -- --date 2026-08-11
```

Expected historical unique totals for the audited static snapshot:

| Date | Expected `total` |
|---|---:|
| 2026-07-23 | 640,925,483 |
| 2026-08-09 | 586,611,582 |
| 2026-08-10 | 57,881,312 |
| 2026-08-11 | 811,957,820 |

If source logs changed since the audit, do not change code to force these numbers. Report the current file count and rerun an event-level audit; historical files should normally remain stable.

- [ ] **Step 7: Perform a disposable-store migration acceptance test**

Copy the encrypted config and key into a temporary user-data directory, point a real `electron-store` instance at that copy, and run `rebuildCodexUsage` against the real active/archive roots. Never point this test at the live user-data directory. Assert:

- copied DeepSeek/Kimi rows remain equal;
- copied Codex rows match the verifier;
- copied cursor keys are UUID/basename identities, not absolute paths;
- copied migration marker is true;
- rerunning incremental UUID scan adds zero historical records.

- [ ] **Step 8: Audit diff, security, and repository state**

Run:

```powershell
git diff --check
git status --short
git log -8 --oneline
rg -n "archived_sessions|codexArchiveUuidCursorV1|lastEventFingerprint|store\.store = nextStore" src test scripts docs
```

Confirm no command or test writes live rollout files or live store, no log prints raw event data/private paths, and every task is committed separately.

- [ ] **Step 9: Commit verifier and documentation**

```powershell
git add scripts/verify-codex-archive-usage.js package.json README.md README.en.md docs/diagnostics/codex-local-log.md test/codex-usage-rebuild.test.js test/codex-archive-locallog.test.js
git commit -m "docs: verify Codex archive usage rebuild"
```

- [ ] **Step 10: Hand off live migration safely**

Do not directly patch the user's live `config.json`. Instruct the user to close and restart the newly built application. Verify the migration marker and corrected historical daily totals through a read-only post-start check. If migration fails, confirm the app entered compatibility mode and retained the pre-migration store before debugging.

---

## Final Execution Checklist

- [ ] Each task began with a failing test that failed for the expected missing behavior.
- [ ] Each task ended with its focused tests passing and a dedicated commit.
- [ ] Generic Kimi scanner/rescan tests still pass.
- [ ] Codex move, dual-candidate, replacement, cross-batch duplicate, and global rebuild duplicate tests pass.
- [ ] Startup remains non-blocking and old usage remains visible during migration.
- [ ] Shadow scan and commit failures leave live Codex state untouched.
- [ ] Successful rebuild uses exactly one `store.store` assignment.
- [ ] Manual Codex sync reuses the runtime coordinator; Kimi remains generic.
- [ ] Settings reset retains aggregate, UUID cursor, and migration marker together.
- [ ] Full `npm test` and `npm run build:renderer` pass.
- [ ] Disposable-store acceptance proves migration without touching live state.
- [ ] Read-only historical verification reports the audited 7/23, 8/9, 8/10, and 8/11 totals or documents source-log drift.
