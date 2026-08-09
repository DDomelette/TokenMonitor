# Diagnostics Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Diagnostics Center that runs isolated environment, storage, Windows, network, and provider checks with live status, offline guides, and a redacted copyable report.

**Architecture:** A pure CommonJS diagnostics core owns result normalization, phased execution, timeouts, redaction, and guide resolution. Main-process orchestration owns Electron windows, run ownership, IPC, clipboard, and shell access; a separate static renderer consumes only sanitized progress events and filters them by `runId`.

**Tech Stack:** Electron 40, Node.js CommonJS, `node:test`, `electron-store`, koffi, plain HTML/CSS/JavaScript, electron-builder.

## Global Constraints

- Develop only on `codex/issue-169-diagnostics-center`; the PR base is `main`.
- Status is exactly `pending | running | pass | fail | skipped`; yellow means only `running`.
- Every possible `fail` result has a stable non-empty `guideId`.
- Diagnostics never calls Codex/Kimi `ensureFresh`, refresh functions, provider `fetchQuota`, provider `readLocalLog`, DeepSeek provider `fetchUsage`, `sync:history`, settings mutation, Store reset, or Store recovery mutation.
- Diagnostics never writes credentials, Store data, cursor, migration flags, usage history, registry, or system settings.
- The only allowed write is a random exclusive temporary file under `userData`, removed in `finally`.
- Raw API keys, sessions, access/refresh tokens, encryption keys, Authorization headers, full home paths, stacks, and complete session filenames never cross into renderer results or reports.
- Default check timeout is 8,000 ms; provider network timeout is at most 12,000 ms; remote concurrency is at most 3.
- Re-running replaces the active `runId`; late events from an old run never reach or update the renderer.
- Offline guides are packaged with `extraResources`, not opened from inside `app.asar`.
- Do not implement auto-repair, the optional Acrylic A/B area, or `--diagnostics`.

---

## File Structure

### New main-process core

- `src/main/core/diagnostics/results.js`: status constants, safe result constructors, stable error-code normalization.
- `src/main/core/diagnostics/runner.js`: snapshot creation, phased worker pool, timeout, progress events, stale-run stop, final self-check phase.
- `src/main/core/diagnostics/report.js`: defensive text/path/secret redaction and report formatting.
- `src/main/core/diagnostics/guides.js`: guide whitelist and development/packaged path resolution.
- `src/main/core/diagnostics/readonly-log.js`: bounded recursive file discovery and bounded JSONL sampling without cursors.
- `src/main/core/diagnostics/checks/runtime.js`: version, build-artifact, IPC/window, and final self checks.
- `src/main/core/diagnostics/checks/storage.js`: Store/config/key/access/temp-file checks.
- `src/main/core/diagnostics/checks/windows.js`: platform/build, DWM/koffi/DLL/FFI/handle/Acrylic/fallback/GPU checks.
- `src/main/core/diagnostics/checks/network.js`: proxy normalization, proxy TCP, endpoint reachability, stage classification.
- `src/main/core/diagnostics/checks/providers.js`: DeepSeek/Codex/Kimi read-only credential, log, and quota checks.
- `src/main/core/diagnostics/controller.js`: per-webContents run ownership, in-memory sanitized snapshots, copy/open operations.
- `src/main/core/diagnostics/index.js`: dependency assembly and ordered check registry.

### New renderer and docs

- `src/renderer/diagnostics-window.html`: isolated Diagnostics document.
- `src/renderer/css/diagnostics.css`: grouped result layout and exact status colors/spinner.
- `src/renderer/js/diagnostics-state.js`: UMD pure state reducer keyed by active `runId`.
- `src/renderer/js/diagnostics-window.js`: DOM rendering and IPC control.
- `docs/diagnostics/*.md`: 13 offline troubleshooting guides from the approved spec.

### Modified integration files

- `src/main/index.js`: Diagnostics BrowserWindow lifecycle, theme/backdrop participation, controller creation.
- `src/main/ipc.js`: open/close/run/copy/open-guide handlers.
- `src/preload/preload.js`: diagnostics channel allowlists.
- `src/renderer/js/settings-definitions.js`: “诊断与支持” action definition.
- `src/renderer/js/settings-window.js`: render and bind the diagnostics action button.
- `electron-builder.yml`: `extraResources` packaging.

### New tests

- `test/diagnostics-runner.test.js`
- `test/diagnostics-report.test.js`
- `test/diagnostics-guides.test.js`
- `test/diagnostics-runtime-storage.test.js`
- `test/diagnostics-windows.test.js`
- `test/diagnostics-network.test.js`
- `test/diagnostics-providers.test.js`
- `test/diagnostics-controller.test.js`
- `test/diagnostics-ipc-static.test.js`
- `test/diagnostics-state.test.js`
- `test/diagnostics-renderer-static.test.js`
- `test/diagnostics-integration.test.js`

---

### Task 1: Result Contract and Phased Runner

**Files:**
- Create: `src/main/core/diagnostics/results.js`
- Create: `src/main/core/diagnostics/runner.js`
- Test: `test/diagnostics-runner.test.js`

**Interfaces:**
- Produces: `STATUSES`, `pendingResult(definition)`, `terminalResult(definition, status, fields)`.
- Produces: `createRunSnapshot(runId, checks)` returning `{ runId, checks }`.
- Produces: `runDiagnostics({ runId, checks, emit, isActive, maxRemoteConcurrency, timers })` returning terminal safe-shaped results in definition order; the controller applies defense-in-depth redaction before renderer exposure.
- Check definition: `{ id, group, title, guideId, phase, timeoutMs, run(context) }`.
- Check context: `{ getResults() }`, where `getResults()` returns a copy of terminal results accumulated before that check starts.

- [ ] **Step 1: Install dependencies and verify the branch baseline**

Run:

```powershell
npm ci
npm --prefix renderer ci
npm test
```

Expected: the pre-change suite exits 0. If it fails, stop and investigate the baseline before writing a test.

- [ ] **Step 2: Write failing result-transition, timeout, isolation, ordering, and concurrency tests**

Create tests with this concrete shape:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunSnapshot, runDiagnostics } = require('../src/main/core/diagnostics/runner');

function check(id, phase, run, timeoutMs = 50) {
  return { id, phase, run, timeoutMs, group: 'Test', title: id, guideId: 'app-runtime' };
}

test('runner emits pending snapshot then running and terminal results in definition order', async () => {
  const checks = [
    check('local.ok', 'local', async () => ({ status: 'pass', summary: 'ok' })),
    check('remote.skip', 'remote', async () => ({ status: 'skipped', summary: 'not configured' }))
  ];
  const events = [];
  assert.deepEqual(createRunSnapshot('run-1', checks).checks.map((item) => item.status), ['pending', 'pending']);
  const results = await runDiagnostics({
    runId: 'run-1', checks, emit: (event) => events.push(event), isActive: () => true
  });
  assert.deepEqual(results.map((item) => item.status), ['pass', 'skipped']);
  assert.deepEqual(events.map((event) => event.check.status), ['running', 'pass', 'running', 'skipped']);
});

test('one exception and one timeout fail without preventing the next check', async () => {
  const never = new Promise(() => {});
  const results = await runDiagnostics({
    runId: 'run-2',
    checks: [
      check('throws', 'local', async () => { throw Object.assign(new Error('private'), { code: 'EACCES' }); }),
      check('times-out', 'local', async () => never, 5),
      check('continues', 'local', async () => ({ status: 'pass', summary: 'continued' }))
    ],
    emit() {}, isActive: () => true
  });
  assert.deepEqual(results.map((item) => item.status), ['fail', 'fail', 'pass']);
  assert.equal(results[1].errorCode, 'DIAGNOSTIC_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(results), /private/);
});
```

Add a remote worker-pool test with four deferred checks and assert peak active count is 3. Add an `isActive()` test that becomes false after the first terminal event and assert later checks never call `run`.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```powershell
node --test test/diagnostics-runner.test.js
```

Expected: FAIL because `src/main/core/diagnostics/runner.js` does not exist.

- [ ] **Step 4: Implement the safe result constructors**

Implement `results.js` with exact validation:

```js
const STATUSES = Object.freeze(['pending', 'running', 'pass', 'fail', 'skipped']);

function safeCode(value, fallback = 'DIAGNOSTIC_FAILED') {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_:-]{0,63}$/.test(value)
    ? value
    : fallback;
}

function base(definition, status) {
  if (!STATUSES.includes(status)) throw new TypeError('Invalid diagnostic status');
  return {
    id: definition.id,
    group: definition.group,
    title: definition.title,
    status,
    summary: '',
    errorCode: null,
    guideId: definition.guideId,
    metadata: {}
  };
}

function pendingResult(definition) { return base(definition, 'pending'); }

function terminalResult(definition, status, fields = {}) {
  if (!['pass', 'fail', 'skipped'].includes(status)) throw new TypeError('Invalid terminal status');
  const result = Object.assign(base(definition, status), {
    summary: typeof fields.summary === 'string' ? fields.summary : '',
    metadata: fields.metadata && typeof fields.metadata === 'object' ? fields.metadata : {}
  });
  if (status === 'fail') result.errorCode = safeCode(fields.errorCode);
  return result;
}
```

Export `safeCode` for runner error normalization.

- [ ] **Step 5: Implement timeout, phases, and the bounded remote pool**

Implement `runner.js` so local and windows phases run in definition order, remote checks run through a three-worker index queue, and the final phase runs after every remote worker settles. The key logic must be equivalent to:

```js
async function runOne(definition, context) {
  context.emit({ runId: context.runId, check: Object.assign(pendingResult(definition), { status: 'running' }) });
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => definition.run(context.checkContext)),
      new Promise((_, reject) => {
        timer = context.setTimeout(() => reject(Object.assign(new Error('timeout'), {
          code: 'DIAGNOSTIC_TIMEOUT'
        })), definition.timeoutMs || 8000);
      })
    ]);
    return terminalResult(definition, value.status, value);
  } catch (error) {
    return terminalResult(definition, 'fail', {
      errorCode: safeCode(error && error.code),
      summary: error && error.code === 'DIAGNOSTIC_TIMEOUT'
        ? '检查超时，请查看解决手册'
        : '检查失败，请查看解决手册'
    });
  } finally {
    if (timer) context.clearTimeout(timer);
  }
}
```

Store terminal results by check id and return them in original check order. Pass `getResults: () => orderedTerminalResults()` into each `run` call so the final self-check can verify completion. Before starting each check and before emitting each event, call `isActive(runId)`; stale runs stop launching work and suppress events. `createRunSnapshot` rejects duplicate ids and any definition without a non-empty `guideId`, so a runtime failure can never lack a manual mapping.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```powershell
node --test test/diagnostics-runner.test.js
npm test
git add src/main/core/diagnostics/results.js src/main/core/diagnostics/runner.js test/diagnostics-runner.test.js
git commit -m "feat: add diagnostics runner"
```

Expected: all tests pass and the commit contains only Task 1 files.

---

### Task 2: Redacted Reports, Offline Guide Resolution, and Guide Content

**Files:**
- Create: `src/main/core/diagnostics/report.js`
- Create: `src/main/core/diagnostics/guides.js`
- Create: `docs/diagnostics/app-runtime.md`
- Create: `docs/diagnostics/storage-user-data.md`
- Create: `docs/diagnostics/storage-config.md`
- Create: `docs/diagnostics/windows-acrylic.md`
- Create: `docs/diagnostics/windows-gpu.md`
- Create: `docs/diagnostics/network-proxy.md`
- Create: `docs/diagnostics/network-tls.md`
- Create: `docs/diagnostics/deepseek-api-key.md`
- Create: `docs/diagnostics/deepseek-session.md`
- Create: `docs/diagnostics/codex-auth.md`
- Create: `docs/diagnostics/codex-local-log.md`
- Create: `docs/diagnostics/kimi-auth.md`
- Create: `docs/diagnostics/kimi-local-log.md`
- Modify: `electron-builder.yml`
- Test: `test/diagnostics-report.test.js`
- Test: `test/diagnostics-guides.test.js`

**Interfaces:**
- Produces: `redactText(value, { homeDir })`, `sanitizeDiagnosticResult(result, options)`, and `formatDiagnosticReport(snapshot, environment)`.
- Produces: `GUIDE_IDS`, `resolveGuidePath(guideId, environment)`, and `openGuide(guideId, dependencies)`.

- [ ] **Step 1: Write failing privacy, traversal, missing-guide, open-error, and packaging tests**

Use secret fixtures that are unmistakable:

```js
const snapshot = {
  runId: 'run-secret',
  checks: [{
    id: 'codex.auth', group: 'Codex', title: 'Auth', status: 'fail',
    summary: 'Bearer eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.x refresh_token=refresh-private C:\\Users\\Alice\\.codex',
    errorCode: 'AUTH_FAILED', guideId: 'codex-auth', metadata: { apiKey: 'sk-private-value' }
  }]
};
const report = formatDiagnosticReport(snapshot, {
  appVersion: '1.0.0', platform: 'win32', release: '10.0.26100', arch: 'x64',
  electron: '40.0.0', homeDir: 'C:\\Users\\Alice'
});
assert.doesNotMatch(report, /sk-private|refresh-private|eyJhbGci|C:\\Users\\Alice/);
assert.match(report, /~\\\.codex|<redacted>/);
```

In guide tests, assert all 13 ids resolve in development, `../secret` is rejected with `INVALID_GUIDE_ID`, a missing file returns `GUIDE_NOT_FOUND`, non-empty `shell.openPath` output becomes `GUIDE_OPEN_FAILED`, and `electron-builder.yml` contains `extraResources`, `docs/diagnostics`, and `diagnostics-guides`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test test/diagnostics-report.test.js test/diagnostics-guides.test.js
```

Expected: FAIL because report and guide modules do not exist.

- [ ] **Step 3: Implement defense-in-depth report redaction**

Implement `redactText` in this order:

```js
function redactText(value, options = {}) {
  let text = String(value === undefined || value === null ? '' : value);
  if (options.homeDir) text = text.split(options.homeDir).join('~');
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer <redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '<redacted-jwt>')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/g, '<redacted>')
    .replace(/\b(api[_-]?key|session[_-]?token|access[_-]?token|refresh[_-]?token|encryption[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>');
}
```

`sanitizeDiagnosticResult` must copy only `id`, `group`, `title`, `status`, `summary`, `errorCode`, `guideId`, and sanitized metadata. Drop every metadata key matching `/api.?key|session|access.?token|refresh.?token|authorization|encryption.?key/i`, recursively redact remaining primitive values, and reject nested objects deeper than four levels. `formatDiagnosticReport` must whitelist environment fields and serialize only `sanitizeDiagnosticResult` output; do not serialize unknown snapshot properties.

- [ ] **Step 4: Implement the guide whitelist and safe path resolution**

Define the exact 13 ids from the spec in an immutable set. Development root is `path.join(appPath, 'docs', 'diagnostics')`; packaged root is `path.join(resourcesPath, 'diagnostics-guides')`. Construct the filename only after whitelist validation, verify `fs.statSync(target).isFile()`, and call `shell.openPath(target)`. Return `{ ok: true }` only for an empty shell error string.

- [ ] **Step 5: Write the offline manuals with exact safety sections**

Every file must contain these headings:

```markdown
# 应用运行环境排障
## 这个检测项检查什么
## 常见失败原因
## 安全检查步骤
## 高风险操作提醒
## 提交 Issue 时附上什么
```

Use these concrete instructions per guide:

- `app-runtime`: verify installed version, reopen the app, confirm `renderer/dist` only for source runs; never download replacement binaries from unknown sites.
- `storage-user-data`: verify free disk space and read/write permissions; back up the userData directory before changing permissions.
- `storage-config`: copy `.key` and `config.json` together; never edit, regenerate, or publish `.key`; use recovery backups before manual replacement.
- `windows-acrylic`: enable Windows transparency effects, update display drivers, compare `DSM_DISABLE_ACCENT=1` fallback only in a temporary launch; never import registry files from strangers.
- `windows-gpu`: inspect Electron GPU status and update/roll back the official GPU driver; do not disable global security features.
- `network-proxy`: verify direct/system/custom mode and proxy host/port; do not paste credentials into proxy URLs.
- `network-tls`: verify system time, certificate store, DNS, and security-software interception; never disable certificate verification permanently.
- `deepseek-api-key`: verify the key in DeepSeek console and replace it through the app’s verified field; revoke any exposed key.
- `deepseek-session`: use the app’s re-login flow; never paste the platform session token into an Issue.
- `codex-auth`: run Codex’s official login flow; do not edit or share token fields from `auth.json`.
- `codex-local-log`: verify `~/.codex/sessions` exists and is readable; do not upload full rollout logs without reviewing sensitive prompts.
- `kimi-auth`: run Kimi Code’s official login flow; do not edit or share access/refresh tokens.
- `kimi-local-log`: verify `~/.kimi-code/sessions` and `wire.jsonl`; do not upload complete logs without redaction.

Use these exact titles for the 13 files: `应用运行环境排障`、`用户数据目录排障`、`加密配置排障`、`Windows Acrylic 排障`、`Windows GPU 排障`、`网络代理排障`、`DNS/TLS 排障`、`DeepSeek API Key 排障`、`DeepSeek 平台会话排障`、`Codex 登录凭证排障`、`Codex 本地日志排障`、`Kimi 登录凭证排障`、`Kimi 本地日志排障`，按上方 guide id 的顺序一一对应。

The Issue section in every guide must request only the copied Diagnostics report and the failing check id/error code.

- [ ] **Step 6: Add packaged resources and verify GREEN**

Add:

```yaml
extraResources:
  - from: docs/diagnostics
    to: diagnostics-guides
    filter:
      - "**/*.md"
```

Run:

```powershell
node --test test/diagnostics-report.test.js test/diagnostics-guides.test.js
git diff --check
git add src/main/core/diagnostics/report.js src/main/core/diagnostics/guides.js docs/diagnostics electron-builder.yml test/diagnostics-report.test.js test/diagnostics-guides.test.js
git commit -m "feat: add offline diagnostics guides"
```

---

### Task 3: Runtime and Storage Checks

**Files:**
- Create: `src/main/core/diagnostics/checks/runtime.js`
- Create: `src/main/core/diagnostics/checks/storage.js`
- Test: `test/diagnostics-runtime-storage.test.js`

**Interfaces:**
- Produces: `createRuntimeChecks(dependencies)` and `createStorageChecks(dependencies)` arrays.
- Runtime dependencies: `versions`, `platform`, `arch`, `release`, `buildPaths`, and `getWindows()`.
- Storage dependencies: `fs`, `crypto`, `path`, `userDataDir`, `store`, `validateEncryptionKey`, and `normalizeStoredProxyValue`.

- [ ] **Step 1: Write failing tests for info, build artifacts, initialized Store, key validation, settings validation, and temp cleanup**

Use a real `node:os` temp directory. Write `.key` as `'ab'.repeat(32)` and `config.json` as opaque encrypted bytes, proving the test never parses raw config as JSON. Provide a Store spy whose `get` records calls and whose `set/delete/clear` throw. Assert:

```js
assert.equal(byId(results, 'runtime.versions').status, 'pass');
assert.equal(byId(results, 'runtime.renderer-build').status, 'pass');
assert.equal(byId(results, 'storage.store-initialized').status, 'pass');
assert.equal(byId(results, 'storage.encryption-state').metadata.keyValid, true);
assert.equal(byId(results, 'storage.settings-schema').status, 'pass');
assert.equal(fs.readdirSync(userDataDir).some((name) => name.startsWith('.diagnostics-')), false);
assert.deepEqual(writeCalls, []);
```

Add failure cases for missing renderer, invalid key, invalid proxy, and an injected temp-file close/remove failure. Ensure each result has the expected guide id and no file content in metadata.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/diagnostics-runtime-storage.test.js
```

Expected: FAIL because the check modules do not exist.

- [ ] **Step 3: Implement runtime checks as independent definitions**

Return definitions for:

```text
runtime.versions
runtime.windows-build
runtime.renderer-build
runtime.ipc-roundtrip
runtime.window-references
runtime.self-check
```

`runtime.versions` metadata is exactly `{ app, electron, node, chromium, platform, arch, release }`. Version differences do not fail. `runtime.windows-build` is skipped off Windows. `runtime.renderer-build` uses `fs.accessSync` for the main renderer, preload, and Diagnostics page paths. `runtime.ipc-roundtrip` passes because the check itself was invoked through the diagnostics handler. Window references return booleans only. Mark `runtime.self-check` as `phase: 'final'`; it verifies every preceding definition has one terminal result.

- [ ] **Step 4: Implement storage checks with exclusive temporary writes**

The temporary probe must follow this exact lifecycle:

```js
const name = '.diagnostics-' + crypto.randomBytes(12).toString('hex') + '.tmp';
const target = path.join(userDataDir, name);
let fd = null;
try {
  fd = fs.openSync(target, 'wx', 0o600);
  fs.writeSync(fd, Buffer.from('ok'));
  fs.fsyncSync(fd);
  return { status: 'pass', summary: '用户数据目录可安全创建和删除临时文件' };
} finally {
  try {
    if (fd !== null) fs.closeSync(fd);
  } finally {
    fs.rmSync(target, { force: true });
  }
}
```

Return definitions for `storage.user-data-access`, `storage.store-initialized`, `storage.config-readable`, `storage.temp-write`, `storage.encryption-state`, and `storage.settings-schema`. Config readability reads bytes only; Store initialization proves decrypt/parse. Validate `.key` with `validateEncryptionKey`, proxy with `normalizeStoredProxyValue`, and `historyDays` as a positive integer.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```powershell
node --test test/diagnostics-runtime-storage.test.js
npm test
git add src/main/core/diagnostics/checks/runtime.js src/main/core/diagnostics/checks/storage.js test/diagnostics-runtime-storage.test.js
git commit -m "feat: add runtime storage diagnostics"
```

---

### Task 4: Windows, Acrylic, and GPU Checks

**Files:**
- Create: `src/main/core/diagnostics/checks/windows.js`
- Modify: `test/windows-backdrop.test.js`
- Test: `test/diagnostics-windows.test.js`

**Interfaces:**
- Produces: `collectWindowsCapabilities(dependencies)` returning one cached safe capability snapshot.
- Produces: `createWindowsChecks(dependencies)` definitions that project fields from that shared snapshot.
- Consumes: existing `createAccentApi`, `applyAccent`, and `clearAccent` from `src/main/windows-backdrop.js`.

- [ ] **Step 1: Write failing non-Windows, DLL/FFI, native-handle, cleanup, fallback, and GPU tests**

Build fake koffi libraries whose `func()` records `DwmIsCompositionEnabled` and `SetWindowCompositionAttribute`. Use a fake hidden window with counters for `getNativeWindowHandle`, `setBackgroundMaterial`, and `destroy`. Assert:

```js
assert.equal(snapshot.koffiLoaded, true);
assert.deepEqual(snapshot.libraries, { user32: true, dwmapi: true, gdi32: true });
assert.equal(snapshot.ffiBound, true);
assert.equal(snapshot.nativeHandleValid, true);
assert.equal(snapshot.accentApplied, true);
assert.equal(snapshot.electronFallbackAvailable, true);
assert.equal(clearCalls, 1);
assert.equal(destroyCalls, 1);
```

Make `applyAccent` throw and separately make `setBackgroundMaterial` throw; both cases must still destroy the temporary window. Off Windows, all Windows-only checks are `skipped`, never fail.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/diagnostics-windows.test.js
```

Expected: FAIL because `checks/windows.js` does not exist.

- [ ] **Step 3: Implement a single lazy capability collection promise**

Load each DLL separately so the result can distinguish them. Bind `DwmIsCompositionEnabled` and the Accent entry point without changing user state. Create one `show: false` temporary BrowserWindow, inspect its handle, call injected `applyAccent`, call injected `clearAccent` if Accent was applied, call `setBackgroundMaterial('acrylic')`, and always destroy in `finally`.

Get GPU information only through injected Electron methods:

```js
const gpuFeatures = app.getGPUFeatureStatus();
const gpuBasic = await app.getGPUInfo('basic');
const safeGpu = {
  features: gpuFeatures,
  auxAttributes: gpuBasic && gpuBasic.auxAttributes
    ? { amdSwitchable: !!gpuBasic.auxAttributes.amdSwitchable, optimus: !!gpuBasic.auxAttributes.optimus }
    : {}
};
```

Do not return device paths, driver file paths, command lines, or complete GPU objects.

- [ ] **Step 4: Project the shared snapshot into stable checks**

Return exactly these ids with `phase: 'windows'`:

```text
windows.platform-build
windows.dwm-composition
windows.koffi-runtime
windows.native-libraries
windows.ffi-bindings
windows.native-handle
windows.acrylic-accent
windows.electron-acrylic
windows.gpu
windows.transparency-settings
```

Map Acrylic/DWM/library/handle failures to `windows-acrylic`, GPU failures to `windows-gpu`, and return `windows.transparency-settings` as skipped with “无法通过可靠的无副作用接口确认” when no safe source exists.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```powershell
node --test test/diagnostics-windows.test.js test/windows-backdrop.test.js
npm test
git add src/main/core/diagnostics/checks/windows.js test/diagnostics-windows.test.js test/windows-backdrop.test.js
git commit -m "feat: add windows diagnostics"
```

---

### Task 5: Network and Proxy Checks

**Files:**
- Create: `src/main/core/diagnostics/checks/network.js`
- Test: `test/diagnostics-network.test.js`

**Interfaces:**
- Produces: `classifyNetworkError(error)` returning `{ reachedHttp, stage, errorCode }`.
- Produces: `probeEndpoint(options)` and `probeProxyTcp(options)`.
- Produces: `createNetworkChecks(dependencies)`.

- [ ] **Step 1: Write failing classification and reachability tests**

Table-test these inputs:

```js
[
  [{ code: 'ENOTFOUND' }, 'dns', false],
  [{ code: 'ECONNREFUSED' }, 'tcp', false],
  [{ code: 'PROXY_CONNECT_RESPONSE_TIMEOUT' }, 'proxy-connect', false],
  [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls', false],
  [new Error('Unauthorized: session expired (HTTP 401)'), 'http', true],
  [new Error('HTTP 503: unavailable'), 'http', true],
  [new Error('Failed to parse response'), 'http', true]
]
```

Assert a 401/403 causes network pass, not fail. Test direct, system, and custom proxy modes. For custom proxy TCP, inject a fake socket and assert timeout destroys it; successful `connect` resolves and removes listeners.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/diagnostics-network.test.js
```

Expected: FAIL because the network diagnostic module does not exist.

- [ ] **Step 3: Implement stage classification and endpoint probing**

Use error `code` first, then the safe message patterns above. `probeEndpoint` calls injected `httpGet(url, {}, proxyInput, timeoutOptions)`. A resolved response or `reachedHttp: true` returns pass with metadata `{ stage: 'http', host }`; no response body is retained. All failures return a stable stage code such as `NETWORK_DNS_FAILED`, `NETWORK_TCP_FAILED`, `NETWORK_PROXY_CONNECT_FAILED`, `NETWORK_TLS_FAILED`, or `NETWORK_TIMEOUT`.

- [ ] **Step 4: Implement proxy and provider-host check definitions**

Return:

```text
network.proxy-config
network.system-proxy
network.custom-proxy
network.deepseek-api
network.deepseek-platform
network.codex
network.kimi
```

Use current `normalizeStoredProxyValue`, `classifyStoredProxyValue`, and `resolveElectronSystemProxy`. Skip the two non-selected proxy checks. Endpoint URLs are the existing production hosts; pass the same proxy input shape used by scheduler. Use 5-second transport-stage timeouts and 8-second request timeout. Never attach credentials in network-only checks.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```powershell
node --test test/diagnostics-network.test.js test/http-proxy-resolver.test.js test/proxy-connect-timeout.test.js
npm test
git add src/main/core/diagnostics/checks/network.js test/diagnostics-network.test.js
git commit -m "feat: add network diagnostics"
```

---

### Task 6: Read-Only Provider and Local-Log Checks

**Files:**
- Create: `src/main/core/diagnostics/readonly-log.js`
- Create: `src/main/core/diagnostics/checks/providers.js`
- Test: `test/diagnostics-providers.test.js`

**Interfaces:**
- Produces: `findMatchingFiles({ root, match, fs, maxEntries })` and `readJsonlSample({ file, fs, maxBytes, maxLines })`.
- Produces: `createProviderChecks(dependencies)`.
- Consumes pure parsers `parseRolloutLine`, `parseWireLine`, `tokenExpiryMs`, and existing read-only DeepSeek fetchers.

- [ ] **Step 1: Write failing bounded-read and no-mutation tests**

Create temporary Codex and Kimi directory trees with fixture JSONL files and credential files. Capture credential bytes before the run and compare afterward. Provide a Store spy:

```js
const mutations = [];
const store = {
  get(key) { return safeValues[key]; },
  set(...args) { mutations.push(['set', ...args]); },
  delete(...args) { mutations.push(['delete', ...args]); },
  clear(...args) { mutations.push(['clear', ...args]); }
};
```

Assert `mutations` is empty, credential bytes are identical, and no cursor/migration key is read. Inject spies for `ensureFresh`, `refreshAuth`, `refreshCred`, provider `fetchQuota`, and provider `readLocalLog` that throw if called; the diagnostics must pass without touching them.

Add bounds tests with more than `maxEntries` files and a JSONL file larger than `maxBytes`; assert discovery and read counts remain capped and symlink directories are not followed.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/diagnostics-providers.test.js
```

Expected: FAIL because the provider diagnostics do not exist.

- [ ] **Step 3: Implement bounded file discovery and sampling**

Walk directories iteratively with `lstatSync`, skip symlinks, stop after 2,000 entries, and return at most 20 matches. For one selected file, read at most the final 64 KiB using `openSync/readSync/closeSync`; discard a partial first line when starting after byte zero and return at most 100 complete lines. Never accept a cursor Store.

- [ ] **Step 4: Implement DeepSeek read-only checks**

Return `deepseek.api-key` and `deepseek.session` with `phase: 'remote'` and `timeoutMs: 12000`.

- API key missing: skipped. Present: call `fetchBalance(apiKey, { httpGet, proxyUrl })` directly.
- Session missing: skipped. Present: call `new UsageFetcher().fetchUsageAmount(token, currentMonth, currentYear, { httpGet, proxyUrl })` directly.
- Do not call the DeepSeek provider adapter, because its usage path persists `usageDaily` and `fetchedMonths`.

- [ ] **Step 5: Implement Codex and Kimi checks from raw read-only snapshots**

Return:

```text
codex.auth
codex.sessions
codex.local-log
codex.quota
kimi.auth
kimi.sessions
kimi.local-log
kimi.quota
```

Read and parse credential JSON directly. Convert credential fields to booleans before creating metadata. Use `tokenExpiryMs`/expiry timestamp to classify valid, near-expiry, expired, or unknown. Parse sampled lines only through pure parsers. For valid tokens, call `httpGet` directly with the existing endpoint and required headers; never return the headers. Expired or missing credentials skip quota instead of refreshing.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```powershell
node --test test/diagnostics-providers.test.js test/providers-codex.test.js test/providers-kimi.test.js
npm test
git add src/main/core/diagnostics/readonly-log.js src/main/core/diagnostics/checks/providers.js test/diagnostics-providers.test.js
git commit -m "feat: add provider diagnostics"
```

---

### Task 7: Diagnostics Assembly, Run Ownership, Electron Window, IPC, and Preload

**Files:**
- Create: `src/main/core/diagnostics/controller.js`
- Create: `src/main/core/diagnostics/index.js`
- Modify: `src/main/index.js`
- Modify: `src/main/ipc.js`
- Modify: `src/preload/preload.js`
- Test: `test/diagnostics-controller.test.js`
- Test: `test/diagnostics-ipc-static.test.js`

**Interfaces:**
- Produces: `createDiagnosticsController(dependencies)` with `start(sender)`, `copy(sender, runId)`, `openGuide(sender, guideId)`, and `dispose(senderId)`.
- Produces: `createDiagnostics(dependencies)` assembling ordered checks and the controller.
- Adds dependency functions `getDiagnosticsWindow()` and `createDiagnosticsWindow()` to `setupIPC`.

- [ ] **Step 1: Write failing controller ownership and stale-event tests**

Use fake senders with different numeric ids. Start two runs for one sender before resolving the first; assert only the second run emits terminal progress and only its runId can be copied. Assert sender B cannot copy sender A’s run. Destroy the sender, call `dispose`, and assert no send or clipboard call occurs afterward. Inject `sanitizeDiagnosticResult` and assert a check result containing `metadata.apiKey = 'sk-private'` reaches neither the progress event nor the stored copy snapshot.

Static tests must assert exact channel placement:

```text
preload on: diagnostics:progress
preload send: open:diagnostics, window:close-diagnostics
preload invoke: diagnostics:run, diagnostics:open-guide, diagnostics:copy-report
ipcMain on: open:diagnostics, window:close-diagnostics
ipcMain handle: diagnostics:run, diagnostics:open-guide, diagnostics:copy-report
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test test/diagnostics-controller.test.js test/diagnostics-ipc-static.test.js
```

Expected: FAIL because the controller and integration channels do not exist.

- [ ] **Step 3: Implement per-webContents in-memory ownership**

The controller stores one record per sender id:

```js
records.set(sender.id, {
  runId,
  checks: snapshot.checks,
  environment: safeEnvironment(),
  sender
});
```

`start` returns the pending snapshot immediately and schedules `runDiagnostics` with injected `setImmediate`. Its progress callback first verifies record identity and sender liveness, passes the result through `sanitizeDiagnosticResult`, then updates the sanitized check by id and sends `diagnostics:progress`. `copy` requires exact sender id and runId, formats the stored sanitized snapshot, writes clipboard text, and returns `{ ok: true, length }`. `dispose` deletes the record.

- [ ] **Step 4: Assemble the ordered registry and scheduler observation checks**

`index.js` concatenates runtime, storage, Windows, network, and provider checks. Append one safe scheduler observation per provider containing only `authStatus`, `lastErrorChannel`, `lastFailedAt`, `lastFetchedAt`, and `stale`; map arbitrary `lastError` through a fixed category function before it becomes summary.

- [ ] **Step 5: Add Diagnostics BrowserWindow lifecycle**

In `src/main/index.js`:

- add `diagnosticsWindow` and `diagnostics` variables;
- create a 720×640 resizable window, minimum 560×440, with existing preload, context isolation, rounded corners, theme material, and `show: false`;
- focus/show the existing window on repeated open;
- load `src/renderer/diagnostics-window.html`;
- call existing backdrop/reveal/focus helpers;
- include Diagnostics in safe theme/focus broadcasts and backdrop application;
- capture `const diagnosticsWebContentsId = diagnosticsWindow.webContents.id` immediately after creation and call `diagnostics.dispose(diagnosticsWebContentsId)` on close;
- construct diagnostics after scheduler start and pass it into `setupIPC`.

- [ ] **Step 6: Add IPC handlers and preload allowlists**

Handlers must verify the sender belongs to the active Diagnostics window before run/copy/open-guide. A main or settings renderer invoking these channels receives `DIAGNOSTICS_SENDER_INVALID`. Guide opening uses the controller’s whitelist-backed method. Close only the current Diagnostics window.

- [ ] **Step 7: Verify GREEN and commit**

Run:

```powershell
node --test test/diagnostics-controller.test.js test/diagnostics-ipc-static.test.js test/windows-backdrop.test.js test/theme-sync.test.js
npm test
git add src/main/core/diagnostics/controller.js src/main/core/diagnostics/index.js src/main/index.js src/main/ipc.js src/preload/preload.js test/diagnostics-controller.test.js test/diagnostics-ipc-static.test.js
git commit -m "feat: wire diagnostics window"
```

---

### Task 8: Diagnostics Renderer and Settings Entry

**Files:**
- Create: `src/renderer/diagnostics-window.html`
- Create: `src/renderer/css/diagnostics.css`
- Create: `src/renderer/js/diagnostics-state.js`
- Create: `src/renderer/js/diagnostics-window.js`
- Modify: `src/renderer/js/settings-definitions.js`
- Modify: `src/renderer/js/settings-window.js`
- Test: `test/diagnostics-state.test.js`
- Test: `test/diagnostics-renderer-static.test.js`

**Interfaces:**
- Produces UMD API: `createState()`, `startRun(state, snapshot)`, `applyProgress(state, event)`, `orderedChecks(state)`, `summary(state)`.
- Renderer consumes only `window.api` allowlisted channels.

- [ ] **Step 1: Write failing reducer tests**

Test start, progress, stale filtering, stable order, and counts:

```js
let state = DiagnosticsState.createState();
state = DiagnosticsState.startRun(state, {
  runId: 'new',
  checks: [pending('a'), pending('b')]
});
state = DiagnosticsState.applyProgress(state, { runId: 'old', check: pass('a') });
assert.equal(DiagnosticsState.orderedChecks(state)[0].status, 'pending');
state = DiagnosticsState.applyProgress(state, { runId: 'new', check: pass('a') });
assert.deepEqual(DiagnosticsState.orderedChecks(state).map((item) => item.id), ['a', 'b']);
assert.deepEqual(DiagnosticsState.summary(state), {
  total: 2, pending: 1, running: 0, pass: 1, fail: 0, skipped: 0, complete: false
});
```

- [ ] **Step 2: Write failing static UI and settings-entry tests**

Assert the HTML loads `main.css`, `diagnostics.css`, `theme-mode-link.js`, `diagnostics-state.js`, and `diagnostics-window.js` in dependency order. Assert CSS contains exact selectors for `.status-running .status-icon`, a circular `border-radius: 50%` spinner with yellow color, green pass, red fail, gray skipped/pending, and blue `.guide-link`. Assert settings definitions contain `{ type: 'diagnostics' }` and settings window sends `open:diagnostics` without adding a writable setting key.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
node --test test/diagnostics-state.test.js test/diagnostics-renderer-static.test.js
```

Expected: FAIL because renderer files and entry do not exist.

- [ ] **Step 4: Implement the immutable UMD state reducer**

Follow the existing `settings-debounce.js` UMD pattern. `startRun` copies the snapshot order and indexes by id. `applyProgress` returns the original state for a mismatched runId or unknown id; otherwise clone only the changed maps. `summary` counts all five statuses and sets `complete` when no pending/running remain.

- [ ] **Step 5: Implement the Diagnostics document and CSS**

The DOM contains:

```html
<div class="titlebar">...</div>
<header class="diagnostics-summary" aria-live="polite">...</header>
<main id="diagnosticsGroups"></main>
<footer class="diagnostics-actions">
  <span id="diagnosticsActionStatus" role="status"></span>
  <button id="rerunDiagnosticsBtn">重新诊断</button>
  <button id="copyDiagnosticsBtn" disabled>复制诊断结果</button>
</footer>
```

Render text with `textContent`, never interpolate result text into HTML. Group using definition order. Fail rows show summary and a `button.guide-link` carrying only `guideId`. Skipped rows never receive fail classes or a guide button.

- [ ] **Step 6: Implement renderer control flow and theme handling**

Subscribe to `diagnostics:progress` before invoking `diagnostics:run`. On load and rerun, call `startRun` with the returned snapshot. Copy calls `diagnostics:copy-report(activeRunId)` and shows “已复制诊断结果”. Guide calls `diagnostics:open-guide(guideId)` and displays the returned stable failure on that row. Bind the title-bar close button to `window.api.send('window:close-diagnostics')`. Reuse `ThemeModeLink.resolveTheme`, `get:settings`, `settings:loaded`, `theme:changed`, and `window:focus-state` without exposing settings secrets.

- [ ] **Step 7: Add the settings action**

Add:

```js
{ group: '诊断与支持', key: 'diagnostics.run', type: 'diagnostics', label: '运行环境与功能诊断', default: '' }
```

Render a full-width `id="openDiagnosticsBtn"` button for that type, mark it vertical, and bind `window.api.send('open:diagnostics')`. It must not enter `settingsUpdateQueue`.

- [ ] **Step 8: Verify GREEN and commit**

Run:

```powershell
node --test test/diagnostics-state.test.js test/diagnostics-renderer-static.test.js test/settings-window-theme.test.js test/theme-acrylic.test.js
npm test
git add src/renderer/diagnostics-window.html src/renderer/css/diagnostics.css src/renderer/js/diagnostics-state.js src/renderer/js/diagnostics-window.js src/renderer/js/settings-definitions.js src/renderer/js/settings-window.js test/diagnostics-state.test.js test/diagnostics-renderer-static.test.js
git commit -m "feat: add diagnostics interface"
```

---

### Task 9: Cross-Component Safety Regression and Packaged-Resource Verification

**Files:**
- Create: `test/diagnostics-integration.test.js`

**Interfaces:**
- Verifies the assembled `createDiagnostics` boundary, not mocks of individual helper internals.

- [ ] **Step 1: Write the failing assembled safety regression**

Build an assembled diagnostics instance with temporary Codex/Kimi credential and log roots, fake Electron window/GPU APIs, fake network responses, a read-only Store spy, and fake scheduler snapshot. Run all checks and assert:

```js
assert.equal(results.every((item) => ['pass', 'fail', 'skipped'].includes(item.status)), true);
assert.equal(results.filter((item) => item.status === 'fail').every((item) => item.guideId), true);
assert.deepEqual(storeMutations, []);
assert.equal(fs.readFileSync(codexAuthPath).equals(codexBefore), true);
assert.equal(fs.readFileSync(kimiCredPath).equals(kimiBefore), true);
assert.equal(findDiagnosticTempFiles(userDataDir).length, 0);
assert.doesNotMatch(JSON.stringify(progressEvents), /secret fixture values/);
assert.doesNotMatch(copiedReport, /secret fixture values/);
```

Start two controller runs and close the fake window during the first in-flight remote check; assert no renderer send throws and the old run never emits after close.

- [ ] **Step 2: Prove the assembled regression detects a missing registry group**

First run the assembled test against the completed implementation:

```powershell
node --test test/diagnostics-integration.test.js
```

Expected: PASS. Then use `apply_patch` to temporarily remove `providerChecks` from the concatenation in `src/main/core/diagnostics/index.js`, run the same command and verify it FAILS on the missing provider ids. Immediately restore the exact concatenation with `apply_patch` and rerun; expected PASS. Confirm `git diff -- src/main/core/diagnostics/index.js` is empty before continuing.

- [ ] **Step 3: Run fresh full verification**

Run:

```powershell
npm test
npm run build:renderer
npx electron-builder --win --dir
```

Then locate the newest unpacked output and verify every guide:

```powershell
$unpacked = Get-ChildItem -Directory build | Where-Object Name -Match 'unpacked' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $unpacked) { throw 'unpacked build not found' }
$guideRoot = Join-Path $unpacked.FullName 'resources\diagnostics-guides'
$expected = @('app-runtime','storage-user-data','storage-config','windows-acrylic','windows-gpu','network-proxy','network-tls','deepseek-api-key','deepseek-session','codex-auth','codex-local-log','kimi-auth','kimi-local-log')
foreach ($id in $expected) {
  if (-not (Test-Path -LiteralPath (Join-Path $guideRoot ($id + '.md')))) { throw "missing guide: $id" }
}
```

Expected: complete `npm test` with zero failures, renderer build exit 0, unpacked build exit 0, and all 13 manuals present.

- [ ] **Step 4: Commit the integration guard**

Run:

```powershell
git diff --check
git add test/diagnostics-integration.test.js src/main/core/diagnostics src/main/index.js src/main/ipc.js src/preload/preload.js src/renderer electron-builder.yml docs/diagnostics
git status --short
git commit -m "test: verify diagnostics safety"
```

Before committing, inspect `git status --short` and remove any generated `build/` output from staging; never stage packaged artifacts or unrelated files.

---

### Task 10: Independent Review and GitHub Publication

**Files:**
- Review: every file changed from `origin/main..HEAD`
- Modify: only files required to resolve validated review findings

**Interfaces:**
- Produces: a reviewed feature branch pushed to `origin` and a draft PR targeting `main`.

- [ ] **Step 1: Capture review boundaries and run fresh verification**

Run:

```powershell
$base = git merge-base origin/main HEAD
$head = git rev-parse HEAD
git status -sb
git diff --check $base..$head
npm test
npm run build:renderer
```

Expected: clean worktree, zero diff-check errors, zero test failures, renderer build exit 0.

- [ ] **Step 2: Request an independent code review**

Use `superpowers:requesting-code-review` with:

```text
DESCRIPTION: Issue #169 Diagnostics Center with read-only probes, live IPC progress, offline guides, redacted reports, and separate UI.
PLAN_OR_REQUIREMENTS: docs/superpowers/specs/2026-08-09-diagnostics-center-design.md and this implementation plan.
BASE_SHA: output of git merge-base origin/main HEAD
HEAD_SHA: output of git rev-parse HEAD
```

Require the reviewer to focus on credential mutation, Store/cursor writes, renderer secret exposure, runId races, window-close IPC, timeout cleanup, Windows temporary-window cleanup, guide traversal, and packaging.

- [ ] **Step 3: Resolve review findings with targeted tests**

For every Critical or Important finding, first add or tighten the focused test that reproduces it, run that test and observe the expected failure, make the smallest source change, rerun the focused test, then rerun `npm test`. Commit reviewed fixes with a terse message naming the corrected boundary. If the reviewer reports no Critical or Important findings, make no review-only source commit.

- [ ] **Step 4: Publish a draft PR to main**

Follow `github:yeet`: inspect `git status -sb` and the full diff, stage only intended files, commit any remaining reviewed changes, run fresh relevant checks, push with tracking, and create a draft PR with base `main`. The PR body must include:

```markdown
## What changed
- Added a separate Diagnostics Center with live per-check status.
- Added read-only runtime, storage, Windows, network, and provider probes.
- Added redacted report copying and packaged offline troubleshooting guides.

## Why
Closes #169 by giving users a safe, self-service path to identify feature-specific failures without changing their environment.

## Safety
- Does not refresh or write provider credentials.
- Does not advance local-log cursors or trigger Kimi migration.
- Does not write Store/history/system settings; the temporary storage probe cleans up its exclusive file.

## Validation
- `npm test`
- `npm run build:renderer`
- `npx electron-builder --win --dir`
```

Verify the PR target is `DDomelette/TokenMonitor:main` and report the PR URL, branch, final commit, and validation counts.

---

## Plan Self-Review Checklist

- Every Issue #169 acceptance criterion maps to Tasks 2–9.
- Each production behavior starts with a focused failing test.
- Credentials, logs, Store, Windows, network, UI, packaging, timeout, stale run, and window-close paths all have explicit tests.
- All cross-task names are consistent: `diagnostics:run`, `diagnostics:progress`, `diagnostics:open-guide`, `diagnostics:copy-report`, `open:diagnostics`, `window:close-diagnostics`.
- The report ownership model is per `webContents.id` and active `runId` only.
- The encrypted Store file is checked as readable bytes; decrypt/parse is proven through initialized Store access, not plaintext JSON parsing.
- The plan does not include auto-repair, A/B visual testing, credential refresh, cursor writes, or command-line diagnostics.
