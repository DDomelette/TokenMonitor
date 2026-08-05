# Rounded Window Shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the main window has no drawable or interactive pixels outside its rounded outline across resize and Windows display scaling.

**Architecture:** Add a pure main-process geometry helper that converts a rounded rectangle into bounded scanline rectangles and applies them through `BrowserWindow.setShape()` on Windows/Linux. Reapply it at main-window creation and resize, and match it with CSS root clipping.

**Tech Stack:** Electron 40, Node.js 22, React CSS, Node test runner, Electron/Xvfb smoke CI.

## Constraints

- Scope is Issue #1 and the main window only.
- Preserve `transparent: false`, acrylic material, native resizing, and existing bounds persistence.
- Use a 16 DIP radius matching `--radius-window`.
- No platform API calls in pure geometry tests.
- Windows/Linux use native shape when supported; macOS remains a safe no-op.

---

### Task 1: Add rounded-shape behavior tests

**Files:**
- Create: `test/window-shape.test.js`
- Expected missing module: `src/main/core/window-shape.js`

- [ ] Write geometry tests for corner exclusion, center inclusion, bounds safety, symmetry, and radius clamping.
- [ ] Write fake-window tests for Windows/Linux application and macOS/unsupported no-op behavior.
- [ ] Add source integration guards requiring shape application during main-window creation and resize.
- [ ] Add a CSS guard requiring `#app` to use `border-radius: var(--radius-window)` and `overflow: hidden`.
- [ ] Create a Draft PR and record expected RED before production implementation.

---

### Task 2: Implement native and CSS clipping

**Files:**
- Create: `src/main/core/window-shape.js`
- Modify: `src/main/index.js`
- Modify: `renderer/src/styles.css`
- Test: `test/window-shape.test.js`

- [ ] Implement integer normalization and radius clamping.
- [ ] Build top/bottom one-pixel scanline rectangles plus one central rectangle.
- [ ] Implement `applyRoundedWindowShape(win, options)` using `getContentSize()` and `setShape()` on `win32`/`linux`.
- [ ] Import the helper in `index.js`, apply immediately after main window creation, and reapply inside the existing resize handler.
- [ ] Change `#app` to the shared window radius while retaining `overflow: hidden`.
- [ ] Verify focused tests GREEN.
- [ ] Verify complete `npm test`, renderer build, and Electron smoke in CI.
- [ ] Review final diff, confirm zero unresolved threads, update PR evidence, and squash merge with the verified head SHA.
