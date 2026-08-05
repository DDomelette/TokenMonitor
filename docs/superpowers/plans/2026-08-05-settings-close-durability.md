# Settings Close Durability Implementation Plan

**Goal:** Ensure closing the settings window never discards a pending or in-flight setting write, and keep the window open with visible feedback when persistence fails.

**Architecture:** Extend the existing keyed debounce helper into an asynchronous write queue. Timer-triggered writes call an acknowledged `settings:save` invoke, failed values are restored as pending, and `flush()` immediately emits every pending key while awaiting both those writes and any writes already in flight. The settings close workflow disables duplicate close attempts, awaits `flush()`, closes only after success, and shows a generic inline error on failure. A small pure main-process write helper validates the key, resolves legacy aliases, persists the value, applies its side effect, and broadcasts only after successful persistence. The existing fire-and-forget `settings:update` channel used elsewhere remains unchanged.

## Task 1: Establish RED

- Create `test/settings-close-durability.test.js`.
- Require asynchronous `flush()` and `hasPending()` behavior from the keyed queue.
- Verify flush emits all pending keys immediately and waits for every acknowledgement.
- Verify flush waits for a timer-triggered write already in flight.
- Verify a failed write is restored for a later retry and is not silently lost.
- Require a missing pure `src/main/core/settings-write.js` helper with whitelist, alias, side-effect, and broadcast semantics.
- Guard the new `settings:save` invoke allowlist and IPC handler.
- Guard both settings close buttons so they await queue flush, close only on success, and show an inline error on failure.
- Create a Draft PR and record expected RED while all existing tests remain green.

## Task 2: Implement GREEN

- Extend `src/renderer/js/settings-debounce.js` with asynchronous emit tracking, failed-value restoration, `flush()`, and `hasPending()`.
- Add `src/main/core/settings-write.js`.
- Register `ipcMain.handle('settings:save', ...)` without changing the existing `settings:update` event path.
- Add `settings:save` to the preload invoke allowlist.
- Change the settings window queue writer to `window.api.invoke('settings:save', ...)`.
- Add an inline save-error status and a guarded async close workflow.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Scope boundary

This change makes settings-window writes acknowledged and close-safe. It does not convert React dashboard writes to invoke, redesign store transactions, add rollback after a partially applied side effect, or expose raw main-process errors to the user.