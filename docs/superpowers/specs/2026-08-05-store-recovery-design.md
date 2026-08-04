# Store Recovery and Safe Startup Design

## Scope

This design implements Issue #46, the second bounded part of parent Issue #40. Issue #45 already owns the `.key` creation/read/validation contract and is reused without duplication.

This change covers:

- preventing `electron-store` from clearing an unreadable encrypted config;
- preserving raw `.key` and `config.json` bytes before store construction;
- creating an idempotent recovery copy on failure;
- stopping normal startup and displaying a safe, actionable native recovery dialog;
- opening the recovery directory from that dialog.

It does not attempt automatic decryption, key reconstruction, configuration reset, or silent recovery.

## Current failure mechanism

`src/main/store.js` currently constructs `electron-store` at module load time with `clearInvalidConfig: true`. In the repository's electron-store/conf version, a failed decrypt is eventually surfaced as a parse error. With destructive clearing enabled, that error is treated as an empty store and defaults can be written over the original encrypted file.

Because `src/main/index.js` imports the already-constructed store before `app.whenReady()`, the application also has no controlled startup boundary where it can stop normal initialization and present recovery information.

## Architecture

### 1. Lazy store factory

`src/main/store.js` will export `createStore()` instead of constructing the store during module evaluation. It retains the defaults, legacy migration function, and settings-security exports.

`createStore()` delegates to a pure recovery module and attaches the existing settings-security helpers to the returned store instance. This preserves the runtime shape used by `index.js` while making initialization explicitly fallible.

### 2. Pre-construction recovery snapshot

`src/main/core/store-recovery.js` will capture the source state of:

- `<userData>/.key`
- `<userData>/config.json`

Each record is classified as `data`, `missing`, or `unreadable`. Readable bytes are copied into a private pending recovery directory before key validation or store construction. Backup directories use mode `0700`; copied files and the manifest use mode `0600` on POSIX.

If no source files exist, no pending backup is required for a normal first launch.

### 3. Pending-to-final backup lifecycle

Backups are keyed by a SHA-256 fingerprint of file names, source states, safe system error codes, and readable bytes. The fingerprint is used only as an opaque identifier; raw key or config content never appears in a file name, manifest field, log, or error message.

The lifecycle is:

1. Capture source bytes.
2. Reuse an already verified final backup for the same fingerprint, if present.
3. Otherwise write a private `.pending-*` directory and a manifest before risky initialization.
4. On successful store construction, remove a newly-created pending directory.
5. On failure, atomically rename the pending directory to `backup-<fingerprint-prefix>`.
6. On repeated startup with unchanged source bytes, reuse the verified final directory instead of overwriting it or creating another copy.

A manifest is written last and includes only safe metadata: format version, fingerprint, creation time, source file name, state, byte length, and content hash. An existing backup is reusable only when its manifest and copied file hashes verify.

### 4. Store initialization contract

`initializeStore()` performs these steps:

1. Capture and stage the existing source state.
2. Refuse to generate a new key when `config.json` exists but `.key` is missing.
3. Resolve the key through Issue #45's `loadOrCreateEncryptionKey()`.
4. Construct electron-store with explicit `cwd`, `name: 'config'`, and `clearInvalidConfig: false`.
5. Discard the pending snapshot on success.
6. Finalize and attach the recovery directory on any key/config failure.

The production implementation does not repeat the key-validation regex or key-write logic from Issue #45.

### 5. Safe startup failure boundary

`src/main/index.js` will initialize the store inside `app.whenReady()` before registering providers, IPC, tray, scheduler, or normal windows.

On failure it will:

- emit one structured log containing only safe fields (`code`, `causeCode`, backup status);
- show a native error dialog with the error category, backup path/status, and recovery instructions;
- offer `打开恢复副本` only when a usable backup directory exists;
- use `shell.openPath()` for that button;
- quit without constructing the normal application runtime.

No raw exception message, stack, key bytes, API key, session token, or config body is displayed or logged.

## Error categories

| Code | Meaning |
| --- | --- |
| `KEY_INVALID` | Existing `.key` content is malformed |
| `KEY_MISSING_WITH_CONFIG` | Existing encrypted config has no matching key file |
| `KEY_READ_FAILED` | Existing key cannot be read |
| `KEY_CREATE_FAILED` | A first-launch key cannot be created safely |
| `CONFIG_READ_FAILED` | Config cannot be decrypted, parsed, or read |
| `BACKUP_FAILED` | Existing source material could not be staged safely before initialization |
| `STORE_STARTUP_FAILED` | Fallback category for an unclassified startup failure |

Only stable, allow-listed codes are exposed to users or logs.

## Backup failure behavior

If readable existing source material cannot be copied into a private pending directory, normal store construction does not proceed. The application reports `BACKUP_FAILED` and leaves the original files untouched.

If a source file itself is unreadable, the manifest records a safe error code and the recovery copy is marked partial. Startup still stops; the dialog states that the source file must be made readable before recovery can be complete.

## Testing strategy

Focused Node tests will cover:

- healthy existing config: backup is present before construction and removed after success;
- decryption/parse failure: exact pre-construction bytes are finalized as a recovery copy;
- repeated identical failure: the same verified backup directory is reused;
- invalid key: Issue #45 error is mapped without constructing the store;
- config present with missing key: no replacement key is generated;
- unreadable key/config source paths;
- recovery-directory write failure: store construction is blocked;
- backup file and directory permissions on POSIX;
- safe dialog text and structured metadata with injected secret-looking cause text;
- `store.js` factory wiring and `index.js` early-startup handling.

Repository CI remains the final gate: complete `npm test`, renderer build, and existing Electron/Xvfb smoke coverage must all pass before merge.
