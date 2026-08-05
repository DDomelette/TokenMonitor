# Rounded Window Shape Design

## Goal

Remove every drawn and interactive pixel outside the main window's rounded outline while preserving the current non-layered, resizable acrylic window architecture.

## Current failure

The main `BrowserWindow` is deliberately non-transparent and relies on `roundedCorners: true`, while the React root explicitly uses `border-radius: 0`. This makes the result dependent on the platform compositor's native corner behavior. On platforms or configurations where that compositor clipping is absent or incomplete, the full rectangular native surface remains visible behind the content.

Changing back to `transparent: true` is not selected because the repository already moved away from layered-window opacity/resize behavior to avoid resize artifacts. CSS clipping alone also cannot remove pixels drawn by the native window surface outside the CSS root.

## Selected design

Use Electron's experimental `BrowserWindow.setShape()` API on Windows and Linux to define the actual drawable and interactive native window region. The API states that pixels outside the supplied rectangles are not drawn and mouse events fall through. macOS remains on its native rounded-window path because `setShape()` is not supported there.

A pure `window-shape.js` module will build a rounded rectangle from horizontal scanline spans. The middle area is one rectangle; the top and bottom arcs are represented by one-pixel-high integer rectangles calculated from pixel-center circle geometry. This produces a bounded set of rectangles for the current 16 DIP radius and can be tested without Electron.

The helper will:

- normalize width, height, and radius to finite positive integers;
- clamp radius to half the smaller dimension;
- generate rectangles entirely inside the current content size;
- call `win.setShape(rectangles)` only on `win32` or `linux` and only when the API exists;
- return a boolean indicating whether a native shape was applied.

The main process will apply the shape immediately after creating the main window and again on every native `resize` event. Electron window/content dimensions are reported in device-independent coordinates, so recomputing from `getContentSize()` keeps the radius and clipping aligned across Windows scaling factors and window sizes.

The React `#app` root will use the same `--radius-window` value and `overflow: hidden`. This prevents titlebar, scroll content, statusbar, pseudo-elements, and temporary layout content from painting outside the visual curve inside the shaped native region.

## Test strategy

1. Pure geometry tests prove that center/top-center pixels are included, all four outer corner pixels are excluded, every rectangle remains within bounds, and small windows clamp safely.
2. Application tests prove that Windows/Linux call `setShape()` with the current content size while macOS and unsupported windows are no-ops.
3. Integration guards prove `src/main/index.js` applies the shape at creation and resize, and `renderer/src/styles.css` clips `#app` with the shared radius.
4. The complete repository suite, renderer build, and Electron/Xvfb smoke remain required. The existing smoke exercises actual application creation and resize-related rendering; the geometry helper supplies deterministic platform-independent verification where Xvfb cannot visually validate Windows DWM composition.

## Scope boundary

This change affects the main window only. Login/settings window styling, acrylic material, opacity controls, layout resizing semantics, theme behavior, shadows, and card rounding are unchanged.
