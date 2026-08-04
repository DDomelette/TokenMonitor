# Store Recovery and Safe Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve encrypted store inputs before initialization, stop safely on key/config failure, and provide an actionable recovery dialog without exposing sensitive data.

**Architecture:** A pure recovery coordinator stages raw `.key` and `config.json` bytes before invoking Issue #45's key loader or electron-store. `store.js` becomes a lazy facade, while a new Electron bootstrap initializes it before loading the existing main process.

**Tech Stack:** Node.js CommonJS, Electron, electron-store 8, `node:test`, SHA-256, synchronous startup filesystem operations.

## Global Constraints

- Scope is Issue #46 only; do not reimplement Issue #45's key validation or write logic.
- `clearInvalidConfig` must be explicitly `false`.
- Existing readable source bytes must be staged before Store construction.
- Existing source files must not be deleted, reset, or overwritten on failure.
- Recovery directories use `0700`; copied files and manifests use `0600` on POSIX.
- Repeated failure with unchanged source bytes reuses a verified backup.
- Corrupt or unrelated backup directories are never overwritten.
- User-visible text and logs may contain safe category codes and the recovery path, but never raw exception messages, stacks, keys, tokens, sessions, or config contents.
- `src/main/index.js` must not load after store initialization fails.

---

### Task 1: Stage source bytes before Store construction

**Files:**
- Create: `src/main/core/store-recovery.js`
- Create: `test/store-recovery.test.js`

**Interfaces:**
- `captureRecoverySnapshot({fsImpl, keyPath, configPath})`
- `stageRecoveryBackup({fsImpl, userDataDir, snapshot, now})`
- `discardRecoveryBackup(handle, fsImpl)`

- [x] Write a failing test that creates valid `.key` and `config.json` files and asserts a private pending directory exists inside the fake Store constructor.
- [x] Verify RED because the recovery module does not exist.
- [x] Capture each source as `data`, `missing`, or `unreadable` and fingerprint names, states, safe codes, and readable bytes.
- [x] Create `.pending-<fingerprint-prefix>` with mode `0700`; write source copies and manifest with mode `0600` and exclusive flags.
- [x] Remove a newly-created pending directory only after successful Store construction.
- [x] Verify the focused healthy-start test passes.

### Task 2: Finalize exact recovery material on config failure

**Files:**
- Modify: `src/main/core/store-recovery.js`
- Modify: `test/store-recovery.test.js`

**Interfaces:**
- `StoreStartupError`
- `finalizeRecoveryBackup(handle, fsImpl)`
- `initializeStore({StoreClass, userDataDir, defaults, fsImpl, cryptoImpl, now})`

- [x] Add RED coverage where the Store constructor sees `clearInvalidConfig: false`, observes the staged copy, and throws a secret-looking `SyntaxError`.
- [x] Atomically rename the pending directory to `backup-<fingerprint-prefix>`.
- [x] Preserve source and copied bytes exactly.
- [x] Map the failure to `CONFIG_READ_FAILED` and `SYNTAX_ERROR` without exposing the raw message.
- [x] Verify directory/file modes and zero pending directories after finalization.

### Task 3: Make backup reuse idempotent and collision-safe

**Files:**
- Modify: `src/main/core/store-recovery.js`
- Modify: `test/store-recovery.test.js`

**Interfaces:**
- `verifyBackupDirectory(fsImpl, backupDir, snapshot)`

- [x] Add repeated identical failure coverage.
- [x] Verify one final directory is reused and no duplicate remains.
- [x] Add a corrupt colliding-manifest test.
- [x] Verify the corrupt directory is untouched and a suffixed valid backup is created.
- [x] Require manifest version/fingerprint/source states plus byte length and SHA-256 verification before reuse.

### Task 4: Integrate Issue #45 key semantics

**Files:**
- Modify: `src/main/core/store-recovery.js`
- Modify: `test/store-recovery.test.js`
- Modify: `test/encryption-key.test.js`

**Interfaces:**
- `loadOrCreateEncryptionKey(keyPath, {fs, crypto})`
- Key error mapping:
  - `ENCRYPTION_KEY_INVALID` → `KEY_INVALID`
  - `ENCRYPTION_KEY_READ_FAILED` → `KEY_READ_FAILED`
  - `ENCRYPTION_KEY_CREATE_FAILED` → `KEY_CREATE_FAILED`

- [x] Add invalid-key coverage and prove the Store constructor is not called.
- [x] Add existing-config-without-key coverage and prove no replacement key is generated.
- [x] Add unreadable key and unreadable config coverage with partial backups.
- [x] Keep `store-recovery.js` free of a second key regex, random key generator, or `.key` write path.
- [x] Update the #45 integration guard so the recovery coordinator is the only consumer of the hardened key helper.

### Task 5: Fail closed when backup staging fails

**Files:**
- Modify: `src/main/core/store-recovery.js`
- Modify: `test/store-recovery.test.js`

- [x] Add recovery-root permission failure coverage.
- [x] Add mid-copy `ENOSPC` coverage.
- [x] Block key handling and Store construction after staging failure.
- [x] Preserve originals and remove an incomplete pending directory on a best-effort basis.
- [x] Expose only `BACKUP_FAILED` and an allow-listed system code.

### Task 6: Add safe recovery metadata and dialog model

**Files:**
- Modify: `src/main/core/store-recovery.js`
- Modify: `test/store-recovery.test.js`

**Interfaces:**
- `safeStoreStartupMetadata(error)`
- `buildStoreRecoveryDialog(error)`

- [x] Add secret-injection tests for raw messages, stacks, and causes.
- [x] Return only category, safe cause code, backup status, backup presence, and safe backup error code for logs.
- [x] Show stop-startup wording, category, recovery advice, and complete/partial/no-backup status.
- [x] Offer `打开恢复副本` only when a backup path exists.
- [x] Fall back to `STORE_STARTUP_FAILED` for unknown or malformed errors.

### Task 7: Convert the store module to a lazy facade

**Files:**
- Modify: `src/main/store.js`
- Create: `test/store-bootstrap.test.js`

**Interfaces:**
- `createStore(options)`
- `initialize(options)`
- existing `migrateLegacyKeys()` and settings-security functions
- delegated Store instance methods and properties

- [x] Add RED coverage for lazy loading, facade method binding, defaults, and legacy migration.
- [x] Move electron-store loading into `createStore()`.
- [x] Create the Store only through `initializeStore()`.
- [x] Keep existing consumers compatible with `store.get()`, `store.set()`, `store.store`, and `store.sanitizeSettings()`.
- [x] Throw `STORE_NOT_INITIALIZED` for premature instance access.
- [x] Prove no module-level `new Store` and no `clearInvalidConfig: true` remain.

### Task 8: Add an early Electron bootstrap boundary

**Files:**
- Create: `src/main/core/startup-recovery.js`
- Create: `src/main/bootstrap.js`
- Modify: `package.json`
- Modify: `test/store-bootstrap.test.js`

**Interfaces:**
- `runStoreBootstrap({app, dialog, shell, storeModule, loadMain, logger})`

- [x] Add RED coverage proving `loadMain()` occurs only after store initialization succeeds.
- [x] Add failure coverage proving the dialog may open the backup and `loadMain()` is never called.
- [x] Add dialog/shell failure coverage and require sanitized log categories.
- [x] Point `package.json#main` to `src/main/bootstrap.js`.
- [x] Wait for `app.whenReady()`, run the bootstrap coordinator, and load `./index` only on success.
- [x] Set `app.isQuitting`, quit after failure, and never log raw errors.

### Task 9: Focused verification

**Files:**
- No production changes unless a test reveals a defect.

- [x] Run:

```bash
node --test test/encryption-key.test.js test/store-recovery.test.js test/store-bootstrap.test.js
node --check src/main/core/encryption-key.js
node --check src/main/core/store-recovery.js
node --check src/main/core/startup-recovery.js
node --check src/main/store.js
node --check src/main/bootstrap.js
```

- [x] Confirm 25 focused tests pass with zero failures.
- [x] Review for duplicate key handling, destructive clearing, raw error logging, backup timing, idempotence, and startup sequencing.

### Task 10: Draft PR, full CI, independent review, and merge

**Files:**
- No production changes unless CI or review exposes a defect.

- [ ] Create a Draft PR titled `fix: preserve encrypted config before startup recovery` with `Fixes #46`, parent #40, root cause, scope, and RED/GREEN evidence.
- [ ] Run complete `npm test` and record the actual pass count.
- [ ] Run `npm run build:renderer` and retain the existing Electron/Xvfb smoke test.
- [ ] Independently review every changed production and test file; fix all Blocking and Important findings.
- [ ] Mark ready and perform a SHA-protected squash merge only after every gate passes.
- [ ] Verify #46 closes, confirm #45 remains completed, then close parent #40 with links to both merged PRs.
