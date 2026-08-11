# Diagnostics Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the final Issue #169 review blockers by making the Diagnostics window capability-level read-only, making remote resource limits real across reruns, refreshing run-scoped inputs, and rebuilding the final packaged artifact.

**Architecture:** A dedicated preload exposes a narrow `diagnosticsApi` and a main-process theme projection. Each controller run owns an abortable immutable run scope containing one proxy snapshot and one Windows capability promise; a Diagnostics-instance shared limiter counts underlying remote operations until they actually settle. Storage and Windows probes fail closed around ownership and platform gates, while renderer/runtime/report polish closes the remaining acceptance gaps.

**Tech Stack:** Electron 40, Node.js CommonJS, `node:test`, plain renderer JavaScript/CSS, electron-builder.

## Global Constraints

- Work only on `codex/issue-169-diagnostics-center`; never develop directly on `main`.
- Status remains exactly `pending | running | pass | fail | skipped`; yellow and the animated spinner mean only `running`.
- Diagnostics must not expose or make reachable settings/history/provider/MCP mutation IPC.
- Diagnostics must not call credential refresh, `ensureFresh`, business `fetchQuota/readLocalLog/fetchUsage`, `sync:history`, Store reset/recovery, cursor/migration/history writes, registry writes, or system-setting writes.
- The only allowed write is an exclusively created owned `.diagnostics-<random>.tmp` under `userData`, removed only if this run created it.
- Raw API keys, sessions, access/refresh tokens, Authorization headers, account ids, full home paths, stacks, and complete session filenames never enter Diagnostics renderer payloads or reports.
- Default check timeout is 8,000 ms; provider network timeout is at most 12,000 ms; underlying remote resources across all active/stale runs are at most 3.
- A rerun or window disposal aborts cancelable old resources, suppresses old events, and prevents new old-run work.
- Preserve all current `origin/main` MCP, token-speed, edge-dock, settings, scheduler, preload, and IPC behavior outside the Diagnostics capability.
- Production behavior must be driven by focused RED tests before implementation. Do not use source-text or CSS change-detector assertions.

---

### Task 1: Dedicated Diagnostics Preload and Theme Projection

**Files:**
- Create: `src/preload/diagnostics-preload.js`
- Create: `src/main/core/diagnostics/theme.js`
- Modify: `src/main/core/diagnostics/ipc-registration.js`
- Modify: `src/main/index.js`
- Modify: `src/main/ipc.js`
- Modify: `src/renderer/js/diagnostics-window.js`
- Test: `test/diagnostics-preload.test.js`
- Test: `test/diagnostics-ipc.test.js`
- Test: `test/diagnostics-view.test.js`
- Test: `test/diagnostics-controller.test.js`

**Interfaces:**
- Produces `window.diagnosticsApi` with only `run()`, `copyReport(runId)`, `openGuide(guideId)`, `close()`, `getTheme()`, `onProgress(callback)`, `onThemeChanged(callback)`, and `onFocusState(callback)`.
- Produces `projectDiagnosticsTheme(settings)` returning exactly `{ window: { darkMode, followSystemTheme } }` with safe defaults.
- Adds authorized invoke channel `diagnostics:get-theme`; only the exact active Diagnostics `webContents` may invoke it.
- The existing shared `window.api` remains unchanged for main/settings/login renderers and retains `open:diagnostics` for the settings action.

- [ ] **Step 1: Write the dedicated preload capability RED test**

Run the real new preload through `Module._load` interception, capture `contextBridge.exposeInMainWorld`, and assert the wished-for surface:

```js
assert.equal(exposed.name, 'diagnosticsApi');
assert.deepEqual(Object.keys(exposed.api).sort(), [
  'close', 'copyReport', 'getTheme', 'onFocusState',
  'onProgress', 'onThemeChanged', 'openGuide', 'run'
]);
assert.equal(exposed.api.invoke, undefined);
assert.equal(exposed.api.send, undefined);
assert.equal(exposed.api.on, undefined);
for (const forbidden of [
  'settings:save', 'settings:reset', 'settings:replace-api-key',
  'sync:history', 'refresh:dashboard', 'mcp:rotateToken'
]) assert.equal(invokedChannels.includes(forbidden), false);
```

- [ ] **Step 2: Run the preload test and verify RED**

Run: `node --test test/diagnostics-preload.test.js`

Expected: FAIL because `src/preload/diagnostics-preload.js` and `window.diagnosticsApi` do not exist.

- [ ] **Step 3: Implement the minimal narrow bridge**

Use explicit methods, not channel parameters:

```js
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('diagnosticsApi', Object.freeze({
  run: () => ipcRenderer.invoke('diagnostics:run'),
  copyReport: (runId) => ipcRenderer.invoke('diagnostics:copy-report', runId),
  openGuide: (guideId) => ipcRenderer.invoke('diagnostics:open-guide', guideId),
  getTheme: () => ipcRenderer.invoke('diagnostics:get-theme'),
  close: () => ipcRenderer.send('window:close-diagnostics'),
  onProgress: (callback) => subscribe('diagnostics:progress', callback),
  onThemeChanged: (callback) => subscribe('theme:changed', callback),
  onFocusState: (callback) => subscribe('window:focus-state', callback)
}));
```

- [ ] **Step 4: Write theme projection and sender-authorization RED tests**

Use a fixture containing secrets, cursors, roots, migration data, and hostile accessors:

```js
const projected = projectDiagnosticsTheme({
  window: { darkMode: 'acrylic-dark', followSystemTheme: false },
  providers: { codex: { localLogRoot: 'C:\\Users\\Alice\\.codex' } },
  localLogCursors: { 'C:\\Users\\Alice\\.codex\\sessions\\rollout.jsonl': 99 },
  mcp: { token: 'mcp-private' }
});
assert.deepEqual(projected, {
  window: { darkMode: 'acrylic-dark', followSystemTheme: false }
});
assert.doesNotMatch(JSON.stringify(projected), /Alice|rollout|mcp-private/);
```

Register the real Diagnostics IPC handlers and assert `diagnostics:get-theme` rejects main/settings senders with `DIAGNOSTICS_SENDER_INVALID` and returns only the projection for the exact active sender.

- [ ] **Step 5: Run theme/IPC tests and verify RED**

Run: `node --test test/diagnostics-ipc.test.js test/diagnostics-preload.test.js`

Expected: FAIL because the projection and handler are absent.

- [ ] **Step 6: Implement projection, IPC, and BrowserWindow wiring**

`theme.js` must read own data properties without invoking getters and normalize modes to the existing allowed set. `createDiagnosticsWindow()` must use:

```js
preload: path.join(__dirname, '..', 'preload', 'diagnostics-preload.js')
```

Pass `getDiagnosticsTheme: () => projectDiagnosticsTheme(store.store)` into `registerDiagnosticsIpc`. Do not add the Diagnostics window to `broadcastSettings()`.

- [ ] **Step 7: Convert the renderer to the narrow API and verify no settings payload crosses**

Replace generic bridge calls with:

```js
window.diagnosticsApi.onProgress(applyProgress);
window.diagnosticsApi.onThemeChanged(refreshTheme);
window.diagnosticsApi.onFocusState(applyFocus);
window.diagnosticsApi.getTheme().then(applyThemeProjection);
window.diagnosticsApi.run();
window.diagnosticsApi.copyReport(activeRunId);
window.diagnosticsApi.openGuide(guideId);
window.diagnosticsApi.close();
```

Add a real renderer harness fixture with full settings paths and assert the Diagnostics script never requests or receives `get:settings`/`settings:loaded`.

- [ ] **Step 8: Verify Task 1 GREEN**

Run:

```powershell
node --test test/diagnostics-preload.test.js test/diagnostics-ipc.test.js test/diagnostics-view.test.js test/diagnostics-controller.test.js
node --check src/preload/diagnostics-preload.js
node --check src/main/core/diagnostics/theme.js
```

Expected: all pass, and the existing shared preload/MCP tests remain unchanged.

---

### Task 2: Abortable Runs, Shared Remote Limiter, and Per-Run Inputs

**Files:**
- Create: `src/main/core/diagnostics/limiter.js`
- Modify: `src/main/core/diagnostics/runner.js`
- Modify: `src/main/core/diagnostics/controller.js`
- Modify: `src/main/core/diagnostics/index.js`
- Modify: `src/main/core/diagnostics/checks/network.js`
- Modify: `src/main/core/diagnostics/checks/providers.js`
- Modify: `src/main/core/diagnostics/checks/windows.js`
- Modify: `src/main/core/http.js`
- Modify: `src/main/index.js`
- Test: `test/diagnostics-runner.test.js`
- Test: `test/diagnostics-controller.test.js`
- Test: `test/diagnostics-network.test.js`
- Test: `test/diagnostics-providers.test.js`
- Test: `test/diagnostics-windows.test.js`
- Test: `test/http-proxy-resolver.test.js`
- Test: `test/diagnostics-integration.test.js`

**Interfaces:**
- Produces `createResourceLimiter(limit = 3)` with `acquire(signal) -> Promise<release>` and read-only `active`/`pending` observations for tests.
- `runDiagnostics` additionally consumes `signal`, `remoteLimiter`, and immutable `runScope`.
- Check context becomes `{ getResults(), signal, deadlineMs, runScope }`.
- Run scope is exactly `{ proxy: { mode, input }, windows: Promise<CapabilitySnapshot> }`, captured once at controller `start()`.
- `httpGet/httpPostJson/httpPostForm` continue accepting the existing fourth `timeoutOptions` argument; `timeoutOptions.signal` is optional and aborts active request/socket resources.

- [ ] **Step 1: Write underlying-resource concurrency and cancellation RED tests**

Create deferred remote checks whose wrapper timeout is 5 ms but whose underlying operation remains active until `context.signal` aborts. Share one limiter across two runs:

```js
assert.equal(firstResults.every((item) => item.errorCode === 'DIAGNOSTIC_TIMEOUT'), true);
assert.ok(peakActive <= 3);
assert.equal(activeAfterTimeout, 0);
assert.ok(peakAcrossRerun <= 3);
```

Add a non-cancelable deferred operation and assert a fourth operation does not start until that deferred operation truly settles, even after its UI result timed out.

- [ ] **Step 2: Run runner/controller tests and verify RED**

Run: `node --test test/diagnostics-runner.test.js test/diagnostics-controller.test.js`

Expected: FAIL with underlying peak greater than 3 and old resources still active after replacement/dispose.

- [ ] **Step 3: Implement the limiter and abortable runner contract**

The limiter queues acquisition and releases only from the underlying operation's `finally`:

```js
const release = await remoteLimiter.acquire(runSignal);
const operation = Promise.resolve()
  .then(() => definition.run(checkContext))
  .finally(release);
const visible = await raceVisibleResultWithTimeout(operation, timeoutMs, checkAbortController);
```

Do not release a permit from the timeout branch. Separate phases exactly:

```js
await runSequential(checks.filter((item) => item.phase === 'local'));
await runSequential(checks.filter((item) => item.phase === 'windows'));
await runRemote(checks.filter((item) => item.phase === 'remote'));
await runSequential(checks.filter((item) => item.phase === 'final'));
```

- [ ] **Step 4: Abort prior controller records on rerun and dispose**

Each record owns an `AbortController`. Before `records.set(id, nextRecord)`, abort the previous record. `dispose(id)` deletes and aborts the exact record. Pass `signal`, the shared limiter, and the captured `runScope` to `runDiagnostics`.

- [ ] **Step 5: Write real transport abort RED tests**

Cover direct HTTP request, proxy CONNECT socket, TLS socket, and custom proxy TCP. For each, abort the signal and assert destroy happens once, stage timers/listeners are removed, and the Promise settles with a stable abort code. Also verify an already-aborted signal opens no socket.

- [ ] **Step 6: Run network/http tests and verify RED**

Run:

```powershell
node --test test/diagnostics-network.test.js test/http-proxy-resolver.test.js test/proxy-connect-timeout.test.js
```

Expected: FAIL because `timeoutOptions.signal` is ignored and proxy TCP has no abort listener.

- [ ] **Step 7: Propagate `signal` and deadline through diagnostics transports**

`requestCore` must register one abort listener, call `destroyActiveTransport()`, reject with an allowlisted abort error, and remove the listener in the same settle cleanup as timers. `probeProxyTcp` must destroy the socket and remove its abort listener. Network endpoint checks pass `{ ...TRANSPORT_TIMEOUTS, signal: context.signal }`; provider quota checks pass the same signal/deadline to their low-level diagnostics HTTP boundary. Do not change normal scheduler/provider refresh behavior.

- [ ] **Step 8: Write proxy and Windows per-run snapshot RED tests**

Start run A with direct proxy and capability snapshot A; change the injected values; start run B and assert B uses custom/system proxy and capability snapshot B. Within one run, mutate the backing Store after the first remote check and assert every network/provider check still uses snapshot A.

- [ ] **Step 9: Implement synchronous run-scope capture**

At controller `start()`, call a guarded synchronous `createRunScope()` once. Network and provider definitions read only `context.runScope.proxy`; Windows definitions await only `context.runScope.windows`. Remove factory-lifetime proxy reads and the dependency-object `WeakMap` Windows cache.

- [ ] **Step 10: Verify Task 2 GREEN**

Run:

```powershell
node --test test/diagnostics-runner.test.js test/diagnostics-controller.test.js test/diagnostics-network.test.js test/diagnostics-providers.test.js test/diagnostics-windows.test.js test/http-proxy-resolver.test.js test/proxy-connect-timeout.test.js test/diagnostics-integration.test.js
```

Expected: actual-resource peak is at most 3 across reruns, abort drains cancelable resources, and proxy/Windows values refresh only between runs.

---

### Task 3: Owned Storage Probe and Windows Native Gate

**Files:**
- Modify: `src/main/core/diagnostics/checks/storage.js`
- Modify: `src/main/core/diagnostics/checks/windows.js`
- Test: `test/diagnostics-runtime-storage.test.js`
- Test: `test/diagnostics-windows.test.js`
- Test: `test/diagnostics-integration.test.js`

**Interfaces:**
- The temp probe owns a path only after successful exclusive open; open failure never removes the target.
- Unsupported/unknown Windows build returns a safe capability snapshot without touching Koffi, native DLLs, Accent, or BrowserWindow. GPU remains an independent read-only projection when Electron app APIs are available.

- [ ] **Step 1: Write EEXIST ownership RED test**

Use a deterministic `randomBytes` value and a real pre-existing collision file:

```js
const before = fs.readFileSync(collisionPath);
const result = await tempWriteCheck.run();
assert.equal(result.status, 'fail');
assert.deepEqual(fs.readFileSync(collisionPath), before);
assert.equal(removeCalls, 0);
```

- [ ] **Step 2: Run storage tests and verify RED**

Run: `node --test test/diagnostics-runtime-storage.test.js`

Expected: FAIL because the `finally` block removes the EEXIST target.

- [ ] **Step 3: Implement exact ownership cleanup**

Use separate ownership and descriptor state:

```js
let fd;
let owned = false;
try {
  fd = fsApi.openSync(target, 'wx', 0o600);
  owned = true;
  // write/fsync probe
} finally {
  if (fd !== undefined) safeClose(fd);
  if (owned) safeRemove(target);
}
```

- [ ] **Step 4: Write unsupported-build no-touch RED tests**

For build `10.0.16298`, unknown release, and throwing build resolver, inject getters/spies for `koffi`, `BrowserWindow`, Accent, and DLL loading that fail the test if touched. Assert native/Acrylic checks are stable skipped/fail results with guides and GPU is independently safe.

- [ ] **Step 5: Run Windows tests and verify RED**

Run: `node --test test/diagnostics-windows.test.js test/windows-backdrop.test.js`

Expected: FAIL because the current collector continues into native probing after the build decision.

- [ ] **Step 6: Gate native collection before dependency resolution**

Resolve platform/build first using only the injected build source or `os.release`. If unsupported, return before `resolveKoffi`, `resolveElectron('BrowserWindow')`, library loads, Accent binding, or temporary-window construction. Keep GPU collection in a separate guarded function that never needs the native Acrylic dependencies.

- [ ] **Step 7: Verify Task 3 GREEN**

Run:

```powershell
node --test test/diagnostics-runtime-storage.test.js test/diagnostics-windows.test.js test/windows-backdrop.test.js test/diagnostics-integration.test.js
```

Expected: collisions remain byte-identical and unsupported builds touch no native mutation boundary.

---

### Task 4: Runtime, Renderer, and Report Acceptance Gaps

**Files:**
- Modify: `src/main/core/diagnostics/checks/runtime.js`
- Modify: `src/main/core/diagnostics/report.js`
- Modify: `src/renderer/js/diagnostics-window.js`
- Modify: `src/renderer/css/diagnostics.css`
- Test: `test/diagnostics-runtime-storage.test.js`
- Test: `test/diagnostics-report.test.js`
- Test: `test/diagnostics-view.test.js`

**Interfaces:**
- `runtime.window-references` reports live `main/settings/login/session/diagnostics` booleans and fails when required main/diagnostics references are absent or destroyed.
- Report metadata is projected through an explicit safe-key allowlist; unsafe account/path/file/stack/credential keys are dropped case-insensitively.
- A running row contains an accessible spinner element; `prefers-reduced-motion` disables animation.

- [ ] **Step 1: Write runtime destroyed-reference RED tests**

Inject live and destroyed window objects. Assert diagnostics is included, `isDestroyed()` is called safely, and missing/destroyed required references produce `RUNTIME_WINDOW_REFERENCE_INVALID` without leaking object details.

- [ ] **Step 2: Write hostile metadata RED tests**

Include `accountId`, `account_id`, `path`, `fileName`, `stack`, `credential`, mixed-case variants, quoted JSON `access_token`, and Windows home variants. Assert none occur in sanitized results, progress, or final report while documented safe keys such as `stage`, `mode`, `configured`, `matchingFiles`, and version fields remain.

- [ ] **Step 3: Write running-spinner behavior RED test**

Execute the real Diagnostics renderer and assert a running row contains one element with an accessible status label and spinner class, while pending/pass/fail/skipped rows do not. The test must inspect generated DOM, not CSS source text.

- [ ] **Step 4: Run focused tests and verify RED**

Run:

```powershell
node --test test/diagnostics-runtime-storage.test.js test/diagnostics-report.test.js test/diagnostics-view.test.js
```

Expected: FAIL on destroyed references, unsafe metadata keys, and missing spinner DOM.

- [ ] **Step 5: Implement minimal projections and spinner**

Use own-data reads and fail closed on accessors/proxies. Add the spinner with `textContent`/attributes only; CSS animation is scoped to `.status-running .diagnostic-spinner`, with a `@media (prefers-reduced-motion: reduce)` rule that disables animation.

- [ ] **Step 6: Verify Task 4 GREEN**

Run the same focused command plus `node --check` for the three changed JavaScript files. Expected: all pass.

---

### Task 5: Whole-Branch Regression and Final Artifact

**Files:**
- Modify only files required by Tasks 1–4 and their behavior tests.
- Verify: `test/diagnostics-integration.test.js`
- Verify: packaged `build/win-unpacked` output from the final HEAD.

**Interfaces:**
- Produces one reviewed final-fix commit range on top of `1e0e4e4`.
- Produces a fresh Windows unpacked application whose packed preload/main/package inputs match final HEAD and whose 13 guides exist.

- [ ] **Step 1: Strengthen the assembled guard for the new boundaries**

The real assembly regression must assert:

```js
assert.equal(remotePeakAcrossReruns <= 3, true);
assert.equal(activeRemoteAfterAbort, 0);
assert.deepEqual(themeProjection, { window: expectedTheme });
assert.equal(diagnosticsBridge.settingsSave, undefined);
assert.equal(collisionBytesAfter.equals(collisionBytesBefore), true);
assert.equal(unsupportedWindowsNativeTouches, 0);
assert.equal(runBProxyMode, 'custom');
```

Keep the existing 42-id registry, Store/FS/system fail-closed audits, credential byte comparisons, stale close behavior, and leakage oracle.

- [ ] **Step 2: Run the complete focused Diagnostics suite**

Run:

```powershell
node --test test/diagnostics-runner.test.js test/diagnostics-report.test.js test/diagnostics-guides.test.js test/diagnostics-runtime-storage.test.js test/diagnostics-windows.test.js test/diagnostics-network.test.js test/diagnostics-providers.test.js test/diagnostics-controller.test.js test/diagnostics-ipc.test.js test/diagnostics-preload.test.js test/diagnostics-state.test.js test/diagnostics-view.test.js test/diagnostics-integration.test.js
```

Expected: zero failures.

- [ ] **Step 3: Run full verification**

Run:

```powershell
git diff --check
npm test
npm run build:renderer
npx electron-builder --win --dir
```

Expected: zero test failures, renderer build exit 0, and electron-builder exit 0 from the final HEAD.

- [ ] **Step 4: Verify final packed inputs and resources**

Use `@electron/asar` or the installed asar API to extract/read `build/win-unpacked/resources/app.asar`. Assert packed `src/main/index.js`, `src/main/ipc.js`, `src/preload/diagnostics-preload.js`, shared preload, and `package.json` contain the final Diagnostics plus current MCP/token-speed/edge-dock integrations. Verify all 13 `resources/diagnostics-guides/*.md` files and compare their bytes with `docs/diagnostics`.

- [ ] **Step 5: Commit the final fix wave**

Inspect `git status --short` and the full staged diff. Never stage `build/`, `renderer/dist/`, caches, or unrelated upstream files. Commit all reviewed hardening changes with:

```powershell
git commit -m "fix: enforce diagnostics safety boundaries"
```

- [ ] **Step 6: Write the implementation report**

Append exact RED/GREEN commands, test counts, builder output, packed-input checks, commits, and residual risks to:

`.superpowers/sdd/2026-08-11-diagnostics-security-hardening/final-fix-report.md`

The report is coordination state and remains ignored by Git.

---

## Plan Self-Review

- Final-review Important 1–2 map to Task 1.
- Important 3 maps to Task 3.
- Important 4–5 map to Task 2.
- Important 6 maps to Task 3.
- Important 7 maps to Task 5.
- Spinner, runtime window references, phase ordering, and report defense-in-depth minors map to Tasks 2 and 4.
- No task adds auto-repair, credential refresh, business log scanning, CLI diagnostics, or a shared writable renderer capability.
- All new interfaces are named in the producing task and consumed by later tasks with the same names.
