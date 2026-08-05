# Rounded Window Shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the main window has no drawable or interactive pixels outside its rounded outline across resize and Windows display scaling.

**Architecture:** Add a pure geometry/capability helper under `src/main/core/`. Install a bootstrap observer before loading `index.js`; identify the main window by its `renderer/dist/index.html` navigation, apply `BrowserWindow.setShape()` on Windows/Linux, and reapply on resize. Import a final renderer CSS override after the existing global stylesheet so the React root uses the same 16 DIP radius.

**Tech Stack:** Electron 40, Node.js 22, React CSS, Node test runner, Electron/Xvfb smoke CI.

## Constraints

- Scope is Issue #1 and the main window only.
- Preserve `transparent: false`, acrylic material, native resizing, and existing bounds persistence.
- Use a 16 DIP radius matching `--radius-window`.
- Keep platform calls outside pure geometry construction.
- Windows/Linux use native shape when supported; macOS and unsupported window managers remain safe no-ops.
- Do not modify login, settings, or platform-session windows.

---

### Task 1: Establish RED behavior coverage

**Files:**
- Create: `test/window-shape.test.js`
- Expected missing module: `src/main/core/window-shape.js`

- [x] Add geometry tests for corner exclusion, center inclusion, bounds safety, symmetry, and radius clamping.
- [x] Add fake-window tests for Windows/Linux application and macOS/unsupported no-op behavior.
- [x] Add observer tests requiring non-main navigation to be ignored, the main renderer to be shaped once, and resize to recompute the shape.
- [x] Add a bootstrap source guard requiring observer installation before `loadMain`.
- [x] Add renderer guards requiring a final clipping override imported after `styles.css`.
- [x] Create Draft PR #59 and record RED in Actions run `30981360127`: 176 existing tests passed and 7 new tests failed as expected.

---

### Task 2: Implement native and renderer clipping

**Files:**
- Create: `src/main/core/window-shape.js`
- Modify: `src/main/bootstrap.js`
- Create: `renderer/src/window-shape.css`
- Modify: `renderer/src/main.jsx`
- Modify: `test/window-shape.test.js`

- [x] Implement integer normalization, radius clamping, and rounded scanline rectangles.
- [x] Implement `applyRoundedWindowShape(win, options)` using `getContentSize()` and `setShape()` on Windows/Linux with safe failure handling.
- [x] Implement `installRoundedMainWindowShapeObserver(app, options)` before main loading.
- [x] Match only the main React entry and avoid duplicate resize handlers.
- [x] Add a final CSS override with transparent outer roots and `#app` clipping to `var(--radius-window)`.
- [x] Verify focused and complete tests GREEN.
- [x] Verify renderer build and Electron/Xvfb smoke in CI.

---

### Task 3: Final review and integration

- [ ] Re-run complete CI on the final documentation-aligned head.
- [ ] Review the final production/test/documentation diff for platform safety, duplicate handlers, clipping order, and unrelated changes.
- [ ] Confirm zero unresolved review threads.
- [ ] Update PR #59 with RED/GREEN evidence.
- [ ] Mark ready and squash merge using the verified head SHA.
- [ ] Confirm Issue #1 closes before starting the next issue.
