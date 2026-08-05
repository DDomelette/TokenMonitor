# Keyed Settings Debounce Implementation Plan

**Goal:** Prevent rapid changes to different settings keys from cancelling one another while preserving same-key debounce behavior.

**Architecture:** Add a small UMD-style browser/CommonJS helper that owns one pending timer per settings key. Scheduling a new value clears only that key's prior timer; timers for other keys remain independent. `settings-window.html` loads the helper before `settings-window.js`, and both normal inputs and custom selects delegate to one keyed queue that emits the existing `settings:update` IPC payload.

## Task 1: Establish RED

- Create `test/settings-keyed-debounce.test.js`.
- Require the missing `src/renderer/js/settings-debounce.js` helper.
- Verify different keys retain independent timers and both emit.
- Verify repeated changes to one key coalesce to its latest value only.
- Verify boolean, numeric, text, and select-like values are preserved.
- Guard script load order and integration of both input/select handlers.
- Guard removal of the single global `debounceTimer`.
- Create a Draft PR and record expected RED while all existing tests remain green.

## Task 2: Implement GREEN

- Create `src/renderer/js/settings-debounce.js` with an injectable timer API for deterministic tests.
- Load it before `settings-window.js`.
- Replace the global timer with one keyed update queue.
- Route both `handleChange()` and `handleSelectChange()` through `queue.schedule(key, value)`.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Scope boundary

This issue only prevents cross-key cancellation. It intentionally does not flush pending values when the settings window closes; close-time durability and write-failure feedback remain scoped to Issue #11.