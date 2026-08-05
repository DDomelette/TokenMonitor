# Main Window Theme Synchronization Plan

**Goal:** Make the React main window immediately and persistently follow the effective light/dark theme selected in settings or by the operating system.

**Architecture:** Add a pure renderer theme policy/controller. The policy resolves one effective theme from the persisted `window.followSystemTheme` and `window.darkMode` values plus `prefers-color-scheme`. The controller applies the result to both `documentElement` and `body`, listens to initial settings, live `settings:loaded`, main-process `theme:changed`, and media-query changes, and dispatches one local `tokenmonitor:theme-applied` event when the effective theme changes. ECharts hooks consume that local event and rebuild options so axes and body-appended tooltips update immediately. A final CSS file imported after all existing styles overrides the window, card-adjacent controls, title/status bars, scrollbars, and overlays through the existing theme variables.

## Effective-theme semantics

- `followSystemTheme !== false` is the master system-following preference.
- When the master preference is on, the effective theme is the current system theme regardless of a stale explicit mode value.
- When it is off, `darkMode: dark` and `darkMode: light` are explicit overrides.
- `darkMode: system` remains a compatible system-following value even when the legacy master preference is off.
- Missing values default to system-following behavior.

This gives both existing settings a deterministic meaning without a destructive migration or main-process rewrite.

## Task 1: Establish RED

- Create `test/theme-sync.test.js`.
- Require a missing `renderer/src/theme-sync.js` module.
- Test the complete policy matrix and invalid-value fallback.
- Test initial persisted settings, live settings updates, system media changes, main-process theme notifications, DOM class/data attributes, and listener cleanup with injected fakes.
- Add integration guards requiring App installation, final CSS import ordering, chart rebuild subscription, and dark selectors for the main surface, title/status bars, cards, scrollbars, and overlays.
- Open a Draft PR and record expected RED while the existing suite remains green.

## Task 2: Implement GREEN

- Create `renderer/src/theme-sync.js` with dependency-injected policy/controller functions.
- Install the controller once from `App.jsx` using `getSettings`, `on`, `window.matchMedia`, DOM roots, and a local event dispatcher.
- Add `tokenmonitor:theme-applied` rebuild handling to `useECharts` with cleanup.
- Create `renderer/src/theme.css` and import it last from `main.jsx`.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved threads, update the PR evidence, mark ready, and squash merge with the verified head SHA.
