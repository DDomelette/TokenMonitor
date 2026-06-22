# DeepSeek Monitor Dashboard Layout and B2 UI Design

## Status

Approved for implementation on 2026-06-22.

## Objective

Upgrade DeepSeek Monitor into a product-grade desktop dashboard while preserving the existing DeepSeek-inspired chart language. The upgrade adds a responsive, editable component grid and applies the B2 controlled visual refinement without destabilizing the window drag and resize behavior that is already working.

## Success Criteria

- The main window can enter and leave a dedicated layout editing mode from the title bar.
- Dashboard components can be dragged to different positions on a snapping grid.
- Components can be resized by dragging their edges.
- Resize feedback follows the pointer continuously, then commits only a valid component size preset.
- Other components animate into available positions when a dragged or resized component collides with them.
- Compact and wide layouts are stored independently.
- Every registered component has a live visibility toggle in Settings.
- Existing chart colors, series, stacked-bar behavior, data formatting, and hover tooltips remain intact.
- Existing main-window and settings-window drag and resize behavior does not regress.
- The current black-and-green debug overlay is removed from the production interface.

## Product Direction

The approved visual direction is B2: controlled refinement.

The application keeps:

- Translucent window surfaces.
- Soft blue accents.
- The current general window shape and visual identity.
- The daily stacked bar chart colors and proportions.
- The Token and cost trend chart language.
- ECharts axis-hover tooltips, labels, and totals.

The application may refine:

- Semantic design tokens.
- Typography hierarchy.
- Spacing rhythm.
- Borders, radii, and shadows.
- Title bar buttons and states.
- Status bar hierarchy.
- Settings and login controls.
- Component editing affordances.

## Scope

### Included

- Remove the currently loaded debug overlay.
- Freeze the native window drag and continuous window resize implementation.
- Add GridStack as the dashboard geometry and collision engine.
- Add a layout controller and preset policy layer.
- Add a component registry.
- Add title-bar layout edit and finish controls.
- Add compact and wide responsive layouts.
- Add component visibility synchronization with Settings.
- Add layout migration, validation, persistence, and fallback behavior.
- Apply B2 visual tokens and controlled refinement after the layout foundation is stable.
- Add regression and visual QA coverage.

### Deferred

- A redesigned Debug mode and Settings toggle.
- Arbitrary component sizes outside approved presets.
- Undo and redo history for layout editing.
- User-created components or plugin loading.
- Nested component grids.
- Changes to chart series semantics or tooltip content.

## Architecture

```text
Title Bar Layout Control
          |
          v
Layout Controller <------ Settings Visibility
    |        |                    |
    |        v                    v
    |   Preset Policy       Component Registry
    |        |                    |
    v        v                    v
        GridStack Geometry Engine
                   |
                   v
        Component Lifecycle Adapter
                   |
                   v
         ECharts resize/update hooks
```

### Ownership Boundaries

GridStack owns:

- Grid coordinates.
- Drag and edge-resize interaction.
- Collision detection.
- Automatic placement and reflow.
- Responsive grid geometry.

The layout controller owns:

- Locked and editing modes.
- Active responsive breakpoint.
- Loading and saving layouts.
- Event coalescing.
- Settings synchronization.
- Migration and fallback.

The preset policy owns:

- Legal presets for each component and breakpoint.
- Mapping continuous resize dimensions to the nearest legal preset.
- Snap thresholds and visible snap feedback.
- Minimum and maximum component geometry.

The component registry owns:

- Component identity and label.
- Default visibility.
- Valid presets.
- Default placement per breakpoint.
- Mount, update, resize, and dispose lifecycle hooks.

The existing main-process window system remains independent. Dashboard layout state must never call `BrowserWindow.setBounds()`, `setSize()`, or `setPosition()`.

## Component Registry Contract

Each dashboard component registers one manifest:

```js
registerComponent({
  id: 'latency-chart',
  label: '响应延迟',
  defaultVisible: false,
  presets: {
    compact: ['standard', 'tall'],
    wide: ['half', 'full', 'tall']
  },
  defaultPlacement: {
    compact: { w: 4, h: 8, preset: 'standard' },
    wide: { w: 6, h: 8, preset: 'half' }
  },
  mount: mountLatencyChart,
  update: updateLatencyChart,
  resize: resizeLatencyChart,
  dispose: disposeLatencyChart
});
```

Registry rules:

- IDs are stable and unique.
- Settings visibility controls are generated from registry entries.
- Layout validation accepts only registered IDs.
- Optional components introduced in an upgrade default to hidden.
- A component missing from a saved layout receives its registered default placement.
- A layout entry for a removed or unavailable component is ignored without invalidating the rest of the layout.

## Interaction Design

### Locked Mode

- Locked mode is the default.
- Grid lines, resize handles, and drag handles are hidden.
- Component content behaves normally, including chart hover tooltips.
- Accidental component movement is impossible.

### Entering Edit Mode

- A title-bar layout-grid icon enters edit mode.
- The control has an accessible label and tooltip.
- The icon changes to a finish/check state while editing.
- Subtle grid lines and component boundaries appear.
- The existing `window.layoutLocked` setting mirrors this state.

### Dragging

- Dragging starts from a component header, not chart content.
- The dragged component follows the pointer.
- A placeholder indicates the current legal destination.
- Components crossed by the dragged component animate into their proposed positions.
- Overlap is not allowed in a committed layout.

### Component Resizing

- A selected component exposes edge and corner resize handles supported by its preset policy.
- The component changes size continuously while the pointer moves.
- The nearest legal preset is highlighted when the pointer enters its snap threshold.
- The snap threshold is 24 CSS px from a legal preset boundary.
- Releasing the pointer commits the highlighted preset.
- Releasing outside all thresholds commits the nearest legal preset, never an arbitrary size.
- Component content transitions between compact, standard, full-width, and tall presentations without a visible jump.
- ECharts receives at most one resize request per animation frame during resizing.

### Finishing Edit Mode

- The finish/check title-bar control exits edit mode.
- Grid and resize affordances disappear.
- The latest complete legal layout is persisted.
- An interrupted drag or resize does not persist partial geometry.

## Responsive Layout

Two layout families are stored independently.

### Compact

- Window width: 380 to 639 px.
- Grid columns: 4.
- Dashboard charts occupy full width.
- Components can be reordered vertically and can use standard or tall presets.

### Wide

- Window width: 640 px or greater.
- Grid columns: 12.
- Components can use half-width, full-width, and tall presets as registered.
- Multiple components can share a row.

Crossing the 640 px boundary loads the corresponding stored layout. Automatic compact reflow must not overwrite the wide layout, and automatic wide restoration must not overwrite the compact layout.

## Initial Preset Families

GridStack uses a 24 px row height and a 10 px gutter. Preset geometry is fixed as follows:

| Component | Compact presets | Wide presets |
| --- | --- | --- |
| Fee overview | standard `4x4`, expanded `4x5` | half `6x4`, full `12x4` |
| Daily Token chart | standard `4x8`, tall `4x10` | half `6x8`, full `12x8`, tall `12x10` |
| Token trend | standard `4x7`, tall `4x9` | half `6x7`, full `12x7`, tall `12x9` |
| Cost trend | standard `4x7`, tall `4x9` | half `6x7`, full `12x7`, tall `12x9` |

Component roots receive a `data-layout-preset` attribute so their internal typography, axis spacing, and content density can respond to the committed preset without inspecting pixel dimensions.

## Visibility Behavior

- Settings displays one toggle for every registered component.
- Toggle changes are broadcast to the main window immediately.
- Turning a component off removes it from active geometry but retains its last compact and wide positions.
- Turning a component on first attempts to restore its last position.
- If the previous position is occupied, the layout engine chooses the nearest valid free location.
- Restoring one component must not reset or reorder unrelated components.
- All components may be hidden; an empty dashboard shows a neutral empty state with a Settings shortcut and does not force a component visible.

## Persistence Model

```text
layout:
  version: 1
  compact:
    columns: 4
    items:
      - id
      - x
      - y
      - w
      - h
      - preset
  wide:
    columns: 12
    items:
      - id
      - x
      - y
      - w
      - h
      - preset
```

Visibility remains under the existing `components.*` settings. The existing `window.layoutLocked` setting remains the canonical lock preference.

Persistence rules:

- Pointer movement never writes directly to the store.
- Drag-stop, resize-stop, and finish-edit events produce legal layout snapshots.
- Store writes are debounced and contain a complete breakpoint layout.
- Compact and wide writes are independent.
- Layout writes do not modify API keys, data history, window bounds, zoom, or theme settings.

## Migration

The existing `componentOrder` list is migrated once when no versioned layout exists.

- Compact migration places visible components vertically in the existing order.
- Wide migration uses this deterministic default: fee overview `(0,0,6,4)`, daily Token `(6,0,6,8)`, Token trend `(0,4,6,7)`, and cost trend `(0,11,12,7)`.
- Existing component visibility values are retained.
- Existing `window.layoutLocked` is retained.
- Migration is idempotent and guarded by `layout.version`.
- The old `componentOrder` value may remain readable for rollback compatibility but is no longer written after migration.

## Validation and Recovery

Every loaded layout is validated before GridStack receives it.

- Reject unknown IDs from active geometry.
- Reject duplicate IDs.
- Normalize integer coordinates and dimensions.
- Clamp items to the breakpoint column count.
- Accept only presets registered for the component and breakpoint.
- Resolve overlaps through deterministic nearest-free placement.

If one breakpoint layout is malformed, only that breakpoint returns to its default. Other layout data and unrelated application settings remain intact.

If GridStack cannot initialize, the dashboard falls back to the current single-column document flow. Data display, settings access, and window controls remain usable.

## Chart Preservation

The following behavior is frozen during this upgrade:

- Daily chart series names and stacking order.
- Light blue cache-hit bars.
- Orange cache-miss bars.
- Green output-token bars.
- Daily chart axis-hover tooltip and total.
- Token trend line, area, and incremental bars.
- Cost trend line, area, and incremental bars.
- Existing value formatting in tooltips and axes.

Chart adapters may change resize scheduling but not chart semantics.

## Visual Tokens and B2 Refinement

After the layout engine is stable, shared semantic tokens replace duplicated values across the main, settings, and login windows.

Token categories:

- Brand and interaction colors.
- Semantic success, warning, and danger colors.
- Window, elevated surface, card, input, and overlay surfaces.
- Primary, secondary, muted, and inverse text.
- Border and focus-ring colors.
- Window, component, control, and tooltip radii.
- Spacing scale.
- Typography roles.
- Subtle, component, floating, and modal shadows.
- Interaction durations and easing.

The migration preserves approved chart colors even when chart configuration cannot consume CSS custom properties directly.

## Debug Overlay

The current `debug-overlay.js` script is no longer loaded by the production dashboard in this phase.

A redesigned Debug mode is deferred. Its future requirements are:

- Default off.
- Controlled by a Settings toggle.
- Uses a deliberate diagnostics panel rather than a permanent overlay.
- Does not intercept pointer events or affect layout geometry.

## Performance Requirements

- Target 60 FPS during component drag and resize.
- No store write on pointer-move events.
- No more than one chart resize per animation frame.
- Neighbor reflow animation duration: 180 ms with the shared standard easing token.
- Neighbor movement uses transform-based FLIP animation; component resizing uses width and height updates scheduled once per animation frame.
- Chart resize, layout measurement, and persistence are kept in separate scheduling phases to avoid layout thrashing.

## Testing Strategy

### Unit Tests

Use Node's built-in test runner for pure layout logic:

- Registry validation.
- Preset selection and nearest-preset behavior.
- Compact and wide layout validation.
- Old `componentOrder` migration.
- Hidden component restoration.
- Collision fallback placement.
- Malformed layout recovery.

### Integration Checks

- Settings toggles update the main window in both directions.
- Drag-stop and resize-stop save only legal layouts.
- Restart restores both breakpoint layouts.
- Breakpoint switching preserves independent layouts.
- ECharts resize scheduling is frame-coalesced.

### Manual and Visual QA

- Widths: 380, 639, 640, and 720 px.
- Light and dark themes.
- Every component visible and hidden.
- Drag across every other component.
- Resize every supported edge and corner to every preset.
- Verify tooltip hover before and after layout editing.
- Restart after layout changes.
- Move and resize the native main window after component editing.
- Repeat window drag and resize regression checks for the Settings window.

## Implementation Sequence

1. Remove the current debug overlay load and establish regression checks for frozen window behavior.
2. Add GridStack and create the component registry, layout schema, validator, and migration.
3. Add the layout controller and title-bar editing control.
4. Add preset edge resizing, snap feedback, and animated collision reflow.
5. Add compact/wide layout separation and persistence.
6. Replace hard-coded component visibility handling with registry-driven live synchronization.
7. Apply shared design tokens and B2 controlled visual refinement.
8. Run syntax, unit, integration, window regression, and visual QA checks.

## Acceptance Boundary

This phase is complete only when the dashboard layout system works without reintroducing native window growth, jump-back, missing top-edge resize, or settings-window drag expansion. A visual improvement does not justify weakening those window guarantees.
