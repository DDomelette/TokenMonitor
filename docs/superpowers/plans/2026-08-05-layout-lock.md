# Layout Lock Implementation Plan

**Goal:** Make the persisted `window.layoutLocked` setting immediately control whether the React dashboard may enter or remain in GridStack edit mode.

**Architecture:** Add a small renderer policy/controller that interprets every value except explicit `false` as locked, restores the initial persisted value, consumes live `settings:loaded` updates, ignores a stale initial read after a newer live update, and owns listener cleanup. `App` remains the single owner of local edit state. It derives `effectiveEditing = editing && !layoutLocked`, passes that value to both TitleBar and Dashboard, refuses locked toggle attempts, and clears stale local edit state when locking becomes active. Dashboard therefore reuses its existing `editing`-driven `setStatic()` and `staticGrid` behavior without duplicating settings subscriptions. TitleBar receives the lock flag and disables the edit button.

## Task 1: Establish RED

- Create `test/layout-lock.test.js`.
- Require a missing `renderer/src/layout-lock.js` module.
- Test default-locked semantics, explicit unlock, persisted restoration, live updates, stale initial-read suppression, and cleanup.
- Add App integration guards for default locked state, one controller effect, safe edit exit, guarded toggling, and effective editing passed to both children.
- Add TitleBar guards for a disabled locked button, non-active locked appearance, and accessible locked state.
- Add a final disabled-button stylesheet import guard.
- Create a Draft PR and record expected RED while the complete existing suite remains green.

## Task 2: Implement GREEN

- Create `renderer/src/layout-lock.js`.
- Update `App.jsx` to install synchronization and derive effective editing.
- Update `TitleBar.jsx` to disable the layout button while locked.
- Add `renderer/src/layout-lock.css` and import it after the other final overrides.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge with the verified head SHA.
