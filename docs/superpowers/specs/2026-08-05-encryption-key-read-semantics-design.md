# Encryption Key Read Semantics Design

## Scope

This design implements Issue #45, the first bounded part of parent Issue #40. It changes only the lifecycle of the `.key` encryption-key file. Configuration backup, `clearInvalidConfig`, recovery UI, and startup error presentation remain in Issue #46.

## Problem

`src/main/store.js` currently catches every key read or validation failure and generates a replacement key. That makes three materially different states indistinguishable:

1. the key does not exist on first launch;
2. an existing key is malformed or truncated;
3. an existing key cannot be read because of permissions or another I/O failure.

Only the first state is safe for key generation. Replacing a key in the latter two states can make the existing encrypted configuration unreadable.

## Architecture

Add `src/main/core/encryption-key.js`, a pure CommonJS module with no Electron or `electron-store` dependency. It exports:

- `loadOrCreateEncryptionKey(keyPath, dependencies?)`
- `validateEncryptionKey(raw)`
- `EncryptionKeyError`

`src/main/store.js` remains responsible for deriving the user-data path, then delegates the complete key lifecycle to this module.

## Error contract

| Condition | Result |
| --- | --- |
| Existing valid 64-hex key | Return the trimmed key unchanged |
| Initial read returns `ENOENT` | Create the parent directory, generate a 32-byte key, and write it with `mode: 0600` and `flag: wx` |
| Existing file contains invalid data | Throw `ENCRYPTION_KEY_INVALID`; do not write |
| Existing file read fails for any non-`ENOENT` reason | Throw `ENCRYPTION_KEY_READ_FAILED`; preserve the original error as `cause`; do not write |
| Key creation fails | Throw `ENCRYPTION_KEY_CREATE_FAILED` |
| Exclusive creation loses an `EEXIST` race | Re-read and validate the winning file instead of overwriting it |

Error messages expose only stable error categories and system error codes. They must not include key contents or configuration data.

## Security invariants

- Existing `.key` bytes are never modified after a successful read attempt finds the file.
- Invalid content is never treated as a missing file.
- Permission and I/O errors never fall back to key generation.
- New files are created exclusively, preventing a concurrent writer from being overwritten.
- Tests may inject `fs` and `crypto` implementations, but production uses Node built-ins.

## Verification

Node tests cover:

- missing key creation, restrictive POSIX mode, and stable re-read;
- invalid existing content remaining byte-for-byte unchanged;
- simulated non-`ENOENT` read failure with zero mkdir/write calls;
- exclusive-create `EEXIST` race recovery;
- static integration proving `store.js` delegates to the hardened helper.

The repository-wide `npm test` and renderer build run in GitHub Actions because the execution container cannot resolve `github.com` for a complete clone.
