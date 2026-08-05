# Rounded Window Shape Design

## Goal

Remove drawn and interactive pixels outside the main window's rounded outline while preserving the current non-layered, resizable acrylic window architecture.

## Current failure

The main `BrowserWindow` is deliberately non-transparent and relies on `roundedCorners: true`, while the existing global stylesheet sets `#app { border-radius: 0; }`. The visible result therefore depends on compositor-specific native clipping. Where that clipping is absent or incomplete, the rectangular native surface can remain visible behind the intended curve.

Returning to `transparent: true` is not selected because the repository already moved away from layered-window opacity behavior to avoid resize artifacts. CSS clipping alone also cannot remove native-window pixels or mouse hit targets outside the CSS root.

## Selected design

Use Electron's experimental `BrowserWindow.setShape()` API on Windows and Linux to define the actual drawable and interactive native region. Pixels outside the supplied rectangles are not drawn and do not receive mouse events. macOS remains on its native rounded-window path because `setShape()` is not supported there.

A pure `src/main/core/window-shape.js` module builds a rounded rectangle from horizontal scanline spans. The middle is represented by one rectangle; the top and bottom arcs use one-pixel-high integer rectangles calculated from pixel-center circle geometry. Width, height, and radius are normalized to finite positive integers, and radius is clamped to half the smaller dimension.

The bootstrap process installs a `browser-window-created` observer before `index.js` is loaded. Each new window is watched for navigation, but shape behavior is attached only when its URL matches the main React entry `renderer/dist/index.html`. This identifies the main window without modifying the large main-process entry or affecting login, settings, or platform-session windows. Once matched, the helper applies the shape from `getContentSize()` and reapplies it on every native `resize` event.

`setShape()` is wrapped as a safe capability: Windows/Linux call it when the method is present; macOS, unsupported runtimes, and window-manager failures return a no-op result instead of aborting startup. Electron content sizes are device-independent, so the fixed 16 DIP radius remains aligned across display scaling and window sizes.

The renderer imports a final `window-shape.css` override after the existing global stylesheet. It keeps outer roots transparent and sets `#app` to `border-radius: var(--radius-window)` with `overflow: hidden`, ensuring child content, status areas, pseudo-elements, and temporary layout output remain inside the same visual curve even though the earlier global rule sets radius to zero.

## Test strategy

1. Pure geometry tests prove all four outer corner pixels are excluded, center and edge-center pixels remain included, rectangles stay bounded/integer/positive, symmetry is maintained, and small dimensions clamp safely.
2. Capability tests prove Windows/Linux call `setShape()` with the current content size while macOS and unsupported windows are safe no-ops.
3. Observer tests prove non-main navigation is ignored, the main renderer is shaped once, resize recomputes the shape, and repeated navigation does not install duplicate resize handlers.
4. Integration guards prove bootstrap installs the observer before loading `index.js`, and the final CSS override is imported after `styles.css`.
5. The complete repository suite, renderer build, and Electron/Xvfb smoke remain required. Xvfb verifies real application startup and resize-related rendering; pure geometry tests supply deterministic cross-platform coverage where CI cannot inspect Windows compositor pixels directly.

## Scope boundary

This change affects the main window only. Login/settings/session windows, acrylic material, opacity controls, layout resizing semantics, theme behavior, shadows, card rounding, and persisted bounds are unchanged.
