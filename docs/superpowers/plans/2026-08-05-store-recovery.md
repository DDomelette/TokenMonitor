# Store Recovery and Safe Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve encrypted store inputs before initialization, stop safely on key/config failure, and provide an actionable recovery dialog without exposing sensitive data.

**Architecture:** Add a pure recovery coordinator that stages raw `.key` and `config.json` bytes before invoking Issue #45's key loader or electron-store. Convert `store.js` to a lazy factory and initialize it inside `app.whenReady()`; failures are converted to a native dialog and the normal runtime is not started.

**Tech Stack:** Node.js CommonJS, Electron, electron-store 8, `node:test`, SHA-256, synchronous filesystem operations during startup.

## Global Constraints

- Scope is Issue #46; do not reimplement Issue #45's key validation or write logic.
- `clearInvalidConfig` must be explicitly `false`.
- Existing readable source bytes must be staged before store construction.
- Existing source files must not be deleted, reset, or overwritten on failure.
- Recovery directories use `0700`; copied files and manifests use `0600` on POSIX.
- Repeated failure with unchanged source bytes reuses a verified backup instead of overwriting it or creating duplicates.
- User-visible text and logs may contain safe category codes and the recovery path, but never raw exception messages, stacks, keys, tokens, sessions, or config content.
- No normal providers, scheduler, IPC, tray, login window, settings window, or main window may start after store initialization fails.

---

### Task 1: Specify snapshot and pre-construction staging behavior

**Files:**
- Create: `test/store-recovery.test.js`
- Create: `src/main/core/store-recovery.js`

**Interfaces:**
- Consumes: `loadOrCreateEncryptionKey(keyPath, {fs, crypto})` from `src/main/core/encryption-key.js`.
- Produces:
  - `captureRecoverySnapshot({fsImpl, keyPath, configPath}): RecoverySnapshot`
  - `stageRecoveryBackup({fsImpl, userDataDir, snapshot, now}): BackupHandle`
  - `discardRecoveryBackup(handle): void`
  - `finalizeRecoveryBackup(handle): BackupResult`

- [ ] **Step 1: Write the healthy-start RED test**

Create valid `.key` and `config.json` source files. Use a fake Store constructor that asserts, during construction, that a private pending directory already contains byte-identical copies and a manifest. Return successfully, then assert the pending directory is removed.

Run:

```bash
node --test test/store-recovery.test.js
```

Expected: FAIL because `src/main/core/store-recovery.js` does not exist.

- [ ] **Step 2: Implement source capture**

Represent each source as:

```js
{
  name: '.key',
  state: 'data', // data | missing | unreadable
  data: Buffer.from(...),
  causeCode: null
}
```

Read errors other than `ENOENT` become `unreadable` with an allow-listed system code. They are not converted to `missing`.

- [ ] **Step 3: Implement fingerprinted pending backup creation**

Compute SHA-256 over source names, states, safe cause codes, lengths, and readable bytes. Create:

```text
<userData>/recovery-backups/.pending-<fingerprint-prefix>/
```

Write source copies using mode `0600`, then write `recovery-manifest.json` last. The directory uses mode `0700`.

- [ ] **Step 4: Implement success cleanup**

A newly-created pending backup is removed only after the Store constructor returns successfully. A previously finalized backup is never deleted.

- [ ] **Step 5: Verify GREEN**

Run the focused test and confirm the pending copy exists before construction and is absent after success.

---

### Task 2: Finalize exact recovery bytes on config failure

**Files:**
- Modify: `test/store-recovery.test.js`
- Modify: `src/main/core/store-recovery.js`

**Interfaces:**
- Produces: `StoreStartupError` with safe fields:

```js
{
  code,
  causeCode,
  backupDir,
  backupStatus,
  backupErrorCode
}
```

- [ ] **Step 1: Add a failing Store regression test**

Use a Store constructor that receives `clearInvalidConfig: false` and throws a `SyntaxError` containing secret-looking text. Assert:

- exact source bytes remain unchanged;
- the pending directory is atomically finalized as `backup-<fingerprint-prefix>`;
- the final copy contains exact pre-construction bytes;
- the thrown error is `CONFIG_READ_FAILED`;
- no raw cause message appears in the public error.

- [ ] **Step 2: Verify RED**

Expected: FAIL until failure finalization and safe error mapping exist.

- [ ] **Step 3: Implement Store construction and failure mapping**

Construct with:

```js
new StoreClass({
  defaults,
  cwd: userDataDir,
  name: 'config',
  encryptionKey,
  clearInvalidConfig: false
});
```

On failure, finalize the staged backup and throw a sanitized `StoreStartupError`.

- [ ] **Step 4: Verify GREEN**

Confirm the exact original bytes and backup bytes match and the unsafe exception text is absent.

---

### Task 3: Make repeated recovery idempotent and collision-safe

**Files:**
- Modify: `test/store-recovery.test.js`
- Modify: `src/main/core/store-recovery.js`

**Interfaces:**
- Existing backup verification checks manifest fingerprint and copied file SHA-256 values.

- [ ] **Step 1: Add repeated-failure RED coverage**

Run `initializeStore()` twice against unchanged source bytes and the same failing Store class. Assert both errors reference the same final backup directory and only one verified `backup-*` directory exists.

- [ ] **Step 2: Add invalid-existing-directory coverage**

Pre-create a directory with the expected prefix but a missing or mismatched manifest. Assert the implementation does not overwrite it and safely uses a suffixed directory.

- [ ] **Step 3: Implement verified reuse**

Reuse a final or pending directory only when:

- the manifest version is supported;
- the full fingerprint matches;
- every recorded readable file exists and its SHA-256 matches.

Otherwise create a new suffix without modifying the existing directory.

- [ ] **Step 4: Verify GREEN**

Run the focused suite and confirm deterministic reuse plus non-overwriting collision handling.

---

### Task 4: Integrate Issue #45 key semantics and missing-key protection

**Files:**
- Modify: `test/store-recovery.test.js`
- Modify: `src/main/core/store-recovery.js`

**Interfaces:**
- Maps Issue #45 errors:
  - `ENCRYPTION_KEY_INVALID` → `KEY_INVALID`
  - `ENCRYPTION_KEY_READ_FAILED` → `KEY_READ_FAILED`
  - `ENCRYPTION_KEY_CREATE_FAILED` → `KEY_CREATE_FAILED`

- [ ] **Step 1: Add invalid-key RED coverage**

Write invalid `.key` bytes and existing config bytes. Assert the Store constructor is never entered, both files are backed up, originals remain unchanged, and the public code is `KEY_INVALID`.

- [ ] **Step 2: Add missing-key-with-config RED coverage**

Create `config.json` without `.key`. Assert no key file is generated, the config is backed up, and the public code is `KEY_MISSING_WITH_CONFIG`.

- [ ] **Step 3: Add unreadable-source coverage**

Inject an `fsImpl` that throws `EACCES` when reading `.key` or `config.json`. Assert the error contains only safe codes, no replacement key is written, and any readable source is preserved in a partial backup.

- [ ] **Step 4: Implement key delegation and mappings**

Call Issue #45's helper directly. Do not add another key regex, random key generator, or `.key` write path to `store-recovery.js`.

- [ ] **Step 5: Verify GREEN**

Run all focused tests and confirm the Store constructor is not invoked on precondition failures.

---

### Task 5: Fail closed when recovery staging itself fails

**Files:**
- Modify: `test/store-recovery.test.js`
- Modify: `src/main/core/store-recovery.js`

**Interfaces:**
- Produces `BACKUP_FAILED` before key/store initialization when readable existing material cannot be staged.

- [ ] **Step 1: Add backup-directory failure test**

Inject an `fsImpl` that can read the sources but throws `EACCES` when creating `recovery-backups`. Assert:

- Store construction count remains zero;
- original source bytes remain unchanged;
- error code is `BACKUP_FAILED`;
- only `EACCES` is exposed, not the raw error message.

- [ ] **Step 2: Verify RED**

Expected: FAIL until staging errors block initialization.

- [ ] **Step 3: Implement fail-closed behavior**

Do not invoke `loadOrCreateEncryptionKey()` or `new StoreClass()` when staging readable existing source material fails.

- [ ] **Step 4: Verify GREEN**

Run the focused suite and confirm zero unsafe initialization calls.

---

### Task 6: Convert `store.js` to a lazy factory

**Files:**
- Modify: `src/main/store.js`
- Modify: `test/store-recovery.test.js`

**Interfaces:**
- Produces:
  - `createStore(overrides?): ElectronStoreLike`
  - `defaults`
  - existing `migrateLegacyKeys()`
  - existing settings-security exports

- [ ] **Step 1: Add factory wiring guards**

Assert `store.js` exports `createStore`, delegates to `initializeStore`, and contains no top-level `new Store(...)` or `clearInvalidConfig: true`.

- [ ] **Step 2: Verify RED**

Expected: FAIL against current `store.js`.

- [ ] **Step 3: Implement `createStore()`**

Resolve production dependencies lazily from electron-store and `app.getPath('userData')`. Attach existing settings-security helpers to the returned store instance so calls such as `store.sanitizeSettings(...)` continue to work.

- [ ] **Step 4: Verify GREEN**

Run focused tests and syntax checks:

```bash
node --check src/main/core/store-recovery.js
node --check src/main/store.js
```

---

### Task 7: Add the early startup recovery dialog

**Files:**
- Modify: `src/main/index.js`
- Modify: `test/store-recovery.test.js`

**Interfaces:**
- Consumes:
  - `createStore()`
  - `buildStoreRecoveryDialog(error)`
  - `safeStoreStartupMetadata(error)`
- Uses Electron `dialog.showMessageBox()` and `shell.openPath()`.

- [ ] **Step 1: Add safe dialog model tests**

Inject error fields containing secret-looking strings. Assert the dialog contains:

- stop-startup wording;
- safe error category;
- backup location/status;
- recovery advice;
- `打开恢复副本` only when `backupDir` exists;
- no raw exception text or stack.

- [ ] **Step 2: Add `index.js` static integration guards**

Assert:

- the store is initialized inside `app.whenReady()`;
- recovery is handled before provider registration, scheduler, IPC, tray, or normal windows;
- failure calls `dialog.showMessageBox()`;
- the open action uses `shell.openPath()`;
- normal initialization returns early after failure.

- [ ] **Step 3: Verify RED**

Expected: FAIL against current eager import/initialization.

- [ ] **Step 4: Implement the startup boundary**

Change the Electron import to include `dialog` and `shell`, keep `let store = null`, and call `createStore()` as the first operation inside `app.whenReady()`.

On failure:

```js
const recovery = buildStoreRecoveryDialog(error);
console.error('[store:startup]', JSON.stringify(safeStoreStartupMetadata(error)));
const result = await dialog.showMessageBox(recovery.options);
if (recovery.backupDir && result.response === recovery.openBackupButton) {
  await shell.openPath(recovery.backupDir);
}
app.isQuitting = true;
app.quit();
return;
```

Do not log the thrown error object or stack.

- [ ] **Step 5: Verify GREEN**

Run the focused suite and `node --check src/main/index.js`.

---

### Task 8: Full verification, independent review, and Draft PR

**Files:**
- No production changes unless verification exposes a defect.

- [ ] **Step 1: Run focused verification**

```bash
node --test test/store-recovery.test.js test/encryption-key.test.js
node --check src/main/core/store-recovery.js
node --check src/main/store.js
node --check src/main/index.js
```

Expected: all pass with zero failures.

- [ ] **Step 2: Create a Draft PR and run GitHub Actions**

Required CI gates:

```bash
npm test
npm run build:renderer
```

The existing Electron/Xvfb smoke test must also pass.

- [ ] **Step 3: Independently review the final diff**

Confirm:

- no second key implementation exists;
- no `clearInvalidConfig: true` remains in production;
- no raw exception object is logged or displayed;
- backups are staged before Store construction;
- repeated identical failure reuses a verified backup;
- normal startup code cannot run after initialization failure;
- changes remain limited to Issue #46.

- [ ] **Step 4: Merge only after all gates pass**

Use a SHA-protected squash merge. After merge, verify Issue #46 closes, then close parent #40 only after confirming both #45 and #46 are completed.
