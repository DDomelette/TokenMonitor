# Reset Auto-Launch Side Effect Implementation Plan

**Goal:** Make settings “恢复默认” immediately apply the reset `window.autoLaunch` value to the operating-system login item while preserving the existing always-on-top reset behavior.

**Architecture:** Keep the existing IPC reset flow and always-on-top side effect unchanged. Extend the small, already-tested reset policy module so that after `store.clear()` and preserved-value restoration it synchronizes the post-reset `window.autoLaunch` value through Electron's `app.setLoginItemSettings()`. The synchronization helper accepts an app override for unit tests and otherwise resolves Electron lazily in the main process; plain Node tests remain safe when the Electron API is unavailable. This avoids replacing the large `index.js` and `ipc.js` files for a single reset-only side effect.

## Task 1: Establish RED

- Create `test/settings-reset-external-effects.test.js`.
- Verify an explicit reset value of `false` reaches `setLoginItemSettings()` unchanged.
- Verify `resetSettingsStore()` synchronizes only after clear/default restoration and preserved-data restoration.
- Verify missing Electron APIs are a safe no-op in plain Node tests.
- Guard the existing IPC always-on-top-before-broadcast behavior.
- Guard synchronization ordering inside the reset policy.
- Create a Draft PR and record expected RED while all existing tests remain green.

## Task 2: Implement GREEN

- Add `syncAutoLaunchAfterReset()` to `src/main/core/settings-reset.js`.
- Let `resetSettingsStore(store, options)` invoke it after clear and preserved-value restoration.
- Resolve Electron's app lazily when no test override is supplied.
- Leave `index.js`, `ipc.js`, the reset preservation allowlist, and the existing always-on-top side effect unchanged.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Scope boundary

This change only synchronizes the existing auto-launch external effect after settings reset. It does not change reset preservation policy, add new settings, alter the existing always-on-top replay, or modify platform-specific packaging.