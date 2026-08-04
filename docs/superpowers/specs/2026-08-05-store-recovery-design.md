# Store Recovery and Safe Startup Design

## Scope

This design implements Issue #46, the second bounded part of parent Issue #40. Issue #45 already defines the `.key` creation, read, validation, and exclusive-write contract. This change consumes that helper and does not create a second key implementation.

The deliverable prevents an unreadable encrypted configuration from being silently replaced, preserves recovery material before store construction, and stops application startup behind a native recovery dialog. It does not attempt automatic decryption, key reconstruction, configuration reset, or silent recovery.

## Failure mechanism

The previous `src/main/store.js` constructed electron-store during module evaluation with `clearInvalidConfig: true`. A wrong encryption key or malformed encrypted payload can surface as a parse failure. Destructive invalid-config clearing turns that failure into an empty store, after which defaults may replace the previous configuration.

The eager module-level constructor also gave the application no controlled startup boundary where it could preserve source bytes, stop the scheduler and windows from starting, and present a recovery path.

## Architecture

### Recovery coordinator

`src/main/core/store-recovery.js` is a pure Node module. It:

1. captures `<userData>/.key` and `<userData>/config.json` as `data`, `missing`, or `unreadable` records;
2. computes an opaque SHA-256 fingerprint from names, states, safe system codes, and readable bytes;
3. stages readable bytes in a private pending directory before key resolution or Store construction;
4. delegates key handling to `loadOrCreateEncryptionKey()` from Issue #45;
5. constructs electron-store with explicit `cwd`, `name: 'config'`, and `clearInvalidConfig: false`;
6. removes a newly staged pending copy after successful construction;
7. atomically finalizes the pending copy on any key or configuration failure;
8. returns only sanitized failure categories and backup metadata.

### Backup format and permissions

Recovery material lives under:

```text
<userData>/recovery-backups/
```

A newly staged directory is named `.pending-<fingerprint-prefix>`. A failed startup renames it to `backup-<fingerprint-prefix>`; numeric suffixes prevent collisions. Directories use mode `0700`, and copied files plus `recovery-manifest.json` use mode `0600` on POSIX.

The manifest is written last and contains only safe metadata:

- format version;
- full fingerprint;
- creation timestamp;
- completeness flag;
- source file name and state;
- byte length and SHA-256 for readable files;
- allow-listed system error code for unreadable files.

It never contains key bytes, configuration contents, API keys, sessions, tokens, raw exception messages, or stacks.

### Idempotence and collision handling

A final or pending backup is reused only when:

- the manifest version and fingerprint match;
- every source state and safe cause code match;
- every readable copied file is byte-identical and its recorded size/hash verifies.

Repeated startup with unchanged source data therefore references one verified recovery directory. A corrupt or unrelated directory with the expected prefix is never overwritten; a suffixed directory is used instead.

If copying fails midway, the incomplete pending directory is removed on a best-effort basis and normal initialization is blocked. If final rename fails, the verified pending directory remains available and the user receives a partial-backup status plus a safe error code.

### Missing and unreadable source rules

- No `.key` and no `config.json`: normal first launch; Issue #45 creates a key and no recovery directory is needed.
- Existing `config.json` without `.key`: stop with `KEY_MISSING_WITH_CONFIG`; never generate a replacement key.
- Invalid existing `.key`: stop with `KEY_INVALID`; preserve both readable files.
- Unreadable `.key`: stop with `KEY_READ_FAILED`; preserve any readable config as a partial backup; never write a replacement key.
- Unreadable `config.json`: stop with `CONFIG_READ_FAILED`; preserve any readable key as a partial backup; never construct electron-store.
- Recovery staging failure: stop with `BACKUP_FAILED` before key handling or Store construction.

### Lazy store facade

`src/main/store.js` exports a lazy facade rather than a module-level Store instance. `initialize()` creates the instance once; subsequent calls return it. Existing consumers continue to use `store.get()`, `store.set()`, `store.store`, `migrateLegacyKeys()`, and the settings-security helpers through the facade.

Accessing Store instance members before initialization throws `STORE_NOT_INITIALIZED`. The electron-store dependency is required only inside `createStore()`, which keeps focused Node tests independent of Electron.

### Bootstrap boundary

`package.json` now points Electron to `src/main/bootstrap.js`. The bootstrap waits for `app.whenReady()`, initializes the store, and only then loads the existing `src/main/index.js`.

On failure, `src/main/core/startup-recovery.js`:

- logs only `safeStoreStartupMetadata()` fields;
- builds a native dialog from allow-listed categories;
- explains that startup stopped to protect data;
- shows complete/partial/no-backup status and the recovery path when available;
- offers `打开恢复副本` through `shell.openPath()`;
- quits without loading `index.js`.

Because `index.js` is not loaded after failure, provider registration, scheduler startup, IPC setup, tray creation, login/settings/main windows, migrations, and configuration writes cannot run.

Dialog and shell failures are reduced to `DIALOG_FAILED` or `OPEN_BACKUP_FAILED`. Raw thrown objects, messages, and stacks are never logged or displayed.

## Public startup categories

| Code | Meaning |
| --- | --- |
| `KEY_INVALID` | Existing key contents are malformed |
| `KEY_MISSING_WITH_CONFIG` | Encrypted config exists without its matching key |
| `KEY_READ_FAILED` | Existing key cannot be read |
| `KEY_CREATE_FAILED` | First-launch key creation failed safely |
| `CONFIG_READ_FAILED` | Config cannot be decrypted, parsed, or read |
| `BACKUP_FAILED` | Recovery material could not be staged before initialization |
| `STORE_STARTUP_FAILED` | Unclassified safe fallback |

Only these categories, allow-listed system codes, backup status, and the recovery path are user-visible.

## Verification

Focused RED/GREEN coverage includes:

- staging exact bytes before Store construction and cleanup after success;
- wrong-key/parse failure with byte-identical finalized recovery copies;
- repeated identical failure and corrupt-prefix collision handling;
- invalid, missing, and unreadable key paths;
- unreadable config and recovery-directory/copy failures;
- first launch without source files;
- POSIX directory/file modes;
- safe metadata and dialog models with secret-looking injected causes;
- lazy facade delegation and legacy migration;
- success and failure bootstrap sequencing;
- package entry and static no-destructive-clear guards.

The final repository gate is full `npm test`, `npm run build:renderer`, and the existing Electron/Xvfb smoke test in GitHub Actions.
