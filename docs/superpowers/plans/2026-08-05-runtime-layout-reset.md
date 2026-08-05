# Runtime Layout Reset Implementation Plan

**Goal:** Make settings “恢复默认” immediately remount the live dashboard on the reset layout without restarting the application or writing the old layout back.

**Architecture:** Add a pure renderer snapshot controller that observes initial settings and live `settings:loaded` snapshots. It tracks whether the persisted `layout` is present and emits one reset callback when an authoritative live snapshot transitions to a missing/null layout. A live null snapshot received before the initial read is also treated as authoritative and suppresses the stale initial result. `App` owns a `dashboardGeneration` counter and passes it as the React `key` for Dashboard. Incrementing the key unmounts the old Dashboard, whose existing cleanup removes the GridStack change handler before `destroy(false)`, then mounts a fresh Dashboard that calls `getSettings()` and runs `validateState(null, settings)` for both compact and wide layouts.

## Task 1: Establish RED

- Create `test/runtime-layout-reset.test.js`.
- Require a missing `renderer/src/layout-reset-sync.js` module.
- Test initial presence tracking, one reset per non-null-to-null transition, repeated-null suppression, a second reset after layout becomes non-null again, live-before-initial authority, stale initial suppression, and cleanup.
- Add App integration guards for the controller effect, dashboard generation state, and keyed Dashboard remount.
- Add a Dashboard cleanup guard proving the change listener is removed before `grid.destroy(false)` and that fresh mount validates the complete layout state.
- Create a Draft PR and record expected RED while the existing suite remains green.

## Task 2: Implement GREEN

- Create `renderer/src/layout-reset-sync.js`.
- Update `App.jsx` to install the controller and increment `dashboardGeneration` on reset.
- Add `key={dashboardGeneration}` to Dashboard.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Scope boundary

This change does not alter layout policy, GridStack event handling, settings-reset preservation rules, component visibility, or layout persistence. It only remounts the existing Dashboard when the persisted layout is authoritatively reset.
