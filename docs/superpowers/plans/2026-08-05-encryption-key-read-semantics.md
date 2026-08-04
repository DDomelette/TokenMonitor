# Encryption Key Read Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure TokenMonitor generates `.key` only when it is genuinely absent and never overwrites an invalid or unreadable existing key.

**Architecture:** Move key-file lifecycle logic into a pure Node module under `src/main/core/`. `store.js` derives the user-data path and delegates to the module; tests exercise real temporary files and injected failure paths.

**Tech Stack:** Node.js CommonJS, `node:test`, `node:assert`, Electron, electron-store.

## Global Constraints

- Scope is Issue #45 only; Issue #46 owns configuration backup, recovery UI, and `clearInvalidConfig` changes.
- Existing key files must never be overwritten after an invalid-content or non-`ENOENT` read failure.
- New key files use `0600` on POSIX and an exclusive `wx` write.
- Error text must not include key bytes, API keys, sessions, or configuration contents.
- Use RED → GREEN evidence for every behavior change.

---

### Task 1: Define key creation and stable read behavior

**Files:**
- Create: `test/encryption-key.test.js`
- Create: `src/main/core/encryption-key.js`

**Interfaces:**
- Produces: `loadOrCreateEncryptionKey(keyPath, dependencies?): string`
- Produces: `validateEncryptionKey(raw): string`
- Produces: `EncryptionKeyError`

- [ ] **Step 1: Write the missing-key test**

Create a temporary nested user-data path, call `loadOrCreateEncryptionKey()`, and assert a 64-character hexadecimal key, persisted equality, stable second read, and POSIX mode `0600`.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test test/encryption-key.test.js
```

Expected: FAIL because `src/main/core/encryption-key.js` does not exist.

- [ ] **Step 3: Implement minimal create/read behavior**

Use Node `fs`, `path`, and `crypto`. Read and validate existing content first; only an `ENOENT` result enters creation. Create the parent directory recursively and write a 32-byte random key.

- [ ] **Step 4: Verify GREEN**

Run the focused test and confirm one pass, zero failures.

---

### Task 2: Reject invalid and unreadable existing keys

**Files:**
- Modify: `test/encryption-key.test.js`
- Modify: `src/main/core/encryption-key.js`

**Interfaces:**
- `ENCRYPTION_KEY_INVALID`: existing content is not 64 hexadecimal characters.
- `ENCRYPTION_KEY_READ_FAILED`: an existing or expected key cannot be read for a non-`ENOENT` reason.

- [ ] **Step 1: Add invalid-content regression coverage**

Write a malformed file, capture its exact bytes, call the helper, and assert the error code, sanitized message, and unchanged file contents.

- [ ] **Step 2: Verify RED**

Expected: FAIL because the initial implementation overwrites malformed content.

- [ ] **Step 3: Implement validation errors**

Add `EncryptionKeyError` and `validateEncryptionKey()`. Re-throw validation errors without entering key creation.

- [ ] **Step 4: Add non-ENOENT read-failure coverage**

Inject an `fs` implementation whose `readFileSync()` throws `EACCES`. Assert `ENCRYPTION_KEY_READ_FAILED`, preserved `cause`, and zero calls to mkdir/write.

- [ ] **Step 5: Verify RED, implement the wrapper, and verify GREEN**

Accept optional `{ fs, crypto }` dependencies for deterministic failure testing. Include only the system error code in the public message.

---

### Task 3: Make first-run creation race-safe

**Files:**
- Modify: `test/encryption-key.test.js`
- Modify: `src/main/core/encryption-key.js`

**Interfaces:**
- New key writes use `{ encoding: 'utf8', mode: 0o600, flag: 'wx' }`.

- [ ] **Step 1: Add an `EEXIST` race test**

Simulate `ENOENT` on the initial read, `EEXIST` on the exclusive write, and a valid key on the second read. Assert the winner is returned and was not overwritten.

- [ ] **Step 2: Verify RED**

Expected: FAIL because the initial implementation does not use `wx` or recover from `EEXIST`.

- [ ] **Step 3: Implement exclusive creation and race recovery**

Use `flag: 'wx'`. On `EEXIST`, re-read through the same validation path. Wrap all other creation failures as `ENCRYPTION_KEY_CREATE_FAILED`.

- [ ] **Step 4: Verify GREEN**

Run the focused suite and confirm all behavior tests pass.

---

### Task 4: Wire store initialization to the helper

**Files:**
- Modify: `src/main/store.js`
- Modify: `test/encryption-key.test.js`

**Interfaces:**
- `store.js` calls `loadOrCreateEncryptionKey(path.join(app.getPath('userData'), '.key'))`.

- [ ] **Step 1: Add the integration guard**

Assert that `store.js` imports and calls `loadOrCreateEncryptionKey`, and no longer contains direct `crypto.randomBytes` or `.key` writes.

- [ ] **Step 2: Verify RED**

Expected: FAIL against current `main`, which still contains the catch-all implementation.

- [ ] **Step 3: Replace the inline key lifecycle**

Remove direct `crypto` and `fs` key handling from `store.js`; retain path derivation and delegate to the helper.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node --test test/encryption-key.test.js
node --check src/main/core/encryption-key.js
node --check src/main/store.js
```

Expected: exit code 0 for all commands.

---

### Task 5: Repository verification and Draft PR

**Files:**
- No production changes unless verification exposes a defect.

- [ ] **Step 1: Run complete CI**

GitHub Actions must run:

```bash
npm test
npm run build:renderer
```

Expected: zero test failures and build exit code 0.

- [ ] **Step 2: Review the final diff**

Confirm the branch changes only the helper, store wiring, focused tests, design, and plan. Confirm `clearInvalidConfig` is unchanged and Issue #46 remains out of scope.

- [ ] **Step 3: Create a Draft PR**

Title:

```text
fix: preserve existing encryption keys on read failure
```

Body must link `Fixes #45`, identify parent #40, list RED/GREEN evidence, report exact CI results, and state that configuration recovery remains in #46.
