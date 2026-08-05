# Reset Auto-Launch Side Effect Implementation Plan

**Goal:** Make settings “恢复默认” immediately apply the reset `window.autoLaunch` value to the operating-system login item while preserving the existing always-on-top reset behavior.

**Architecture:** Extract the small window-setting side-effect switch into a pure core module. The `window.autoLaunch` case calls Electron's `app.setLoginItemSettings()` independently of main-window lifetime, while window-only effects remain guarded by a live main window. The same module exposes a reset helper that replays the reset values for `window.alwaysOnTop` and `window.autoLaunch` through the canonical setting applier. `settings:reset` calls this helper after `resetSettingsStore()` and before broadcasting the new settings.

## Task 1: Establish RED

- Create `test/settings-reset-external-effects.test.js`.
- Require the missing `src/main/core/window-settings.js` module.
- Verify `window.autoLaunch: false` reaches `setLoginItemSettings()` even without a main window.
- Verify always-on-top remains a main-window-only effect.
- Verify reset replay reads and applies the reset values for both external settings, preserving `false`.
- Add source integration guards for `ipc.js` and `index.js`.
- Create a Draft PR and record expected RED while all existing tests remain green.

## Task 2: Implement GREEN

- Create `src/main/core/window-settings.js`.
- Delegate `index.js` `applySetting()` to the pure applier.
- Update `ipc.js` reset handling to replay external settings through the reset helper.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Scope boundary

This change only synchronizes the existing always-on-top and auto-launch external effects after settings reset. It does not change reset preservation policy, add new settings, or modify platform-specific packaging.