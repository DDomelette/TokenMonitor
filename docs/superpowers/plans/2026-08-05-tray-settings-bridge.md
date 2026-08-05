# Tray Settings Bridge Implementation Plan

**Goal:** Make the system-tray “设置” item open or toggle the existing settings window through the same main-process IPC path used by the title-bar gear.

**Architecture:** Keep the existing tray behavior that shows a hidden main window and sends the preload-allowed `open:settings` event. Add a tiny dependency-injected renderer bridge that subscribes to that event and forwards `send('open:settings')` back to the main process. React installs the bridge once and returns the preload unsubscribe callback from its effect. The existing `createSettingsWindow()` remains the single owner of open/close toggle semantics.

**Scope constraints:**

- Do not duplicate settings-window creation in the renderer.
- Do not change title-bar behavior or `createSettingsWindow()` semantics.
- Do not require the main window to have been visible before the tray click.
- Do not add new IPC channels or widen the preload allow-list.

## Task 1: Establish RED

- Create `test/tray-settings-bridge.test.js`.
- Require a missing `renderer/src/settings-bridge.js` behavior module.
- Verify the bridge subscribes to `open:settings`, forwards exactly one same-channel send per event, preserves the returned unsubscribe function, and does nothing before the event.
- Add an App integration guard requiring one mount-time effect and cleanup ownership.
- Open a Draft PR and record the expected module-missing/integration failures while all existing tests remain green.

## Task 2: Implement GREEN

- Create `renderer/src/settings-bridge.js` with the minimal dependency-injected bridge.
- Update `renderer/src/App.jsx` to import `on`, install the bridge once, and return its cleanup function.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved threads, update the PR evidence, mark ready, and squash merge with the verified head SHA.
