# Component Visibility Design

## Goal

Restore the “设置 → 组件” switches so each registered dashboard module can be shown or hidden immediately, while preserving its saved GridStack position and size for later restoration.

## Scope

This change is limited to Issue #2. It does not redesign layout editing, chart data loading, provider discovery, settings storage, or the settings window UI.

## Current behavior and root cause

The settings window already writes boolean values under `components.*`. The main process accepts those keys, stores them, applies the setting, and broadcasts `settings:loaded`.

The React dashboard reads settings only during its initial mount. Its render filter considers provider-backed quota availability, but it never evaluates each component registry entry’s `settingsKey` and `defaultVisible`. Layout validation also intentionally retains all registered component records. Consequently, changing a component switch updates persisted settings but does not change the visible GridStack nodes.

## Chosen design

1. Add a pure visibility helper in the renderer grid layer. It will:
   - read the registry entry for a component ID;
   - resolve the nested value referenced by `settingsKey`;
   - fall back to `defaultVisible` only when the setting is absent;
   - return the visible component ID set for a settings snapshot.
2. Keep the complete validated layout in `layoutRef`. Hiding a component only filters its rendered GridStack node; it does not delete or rewrite its layout record.
3. Let `Dashboard` retain the latest settings snapshot in React state.
4. Subscribe to `settings:loaded` and replace the snapshot when the main process broadcasts a change.
5. Trigger a safe GridStack rebuild when the visible component signature changes.
6. Apply both visibility conditions during rendering:
   - the component switch must be enabled;
   - provider-backed quota modules must still have an available provider.
7. When a hidden component is re-enabled, the existing layout record is used, restoring its previous geometry.

## Alternatives considered

### Delete hidden components from persisted layout

Rejected because it destroys geometry or requires a second shadow layout store. It also causes validation to reinsert missing modules and increases migration complexity.

### Hide nodes with CSS only

Rejected because GridStack would continue reserving space for hidden nodes, so surrounding modules would not reflow correctly.

### Incrementally add and remove GridStack nodes

Possible, but more stateful and error-prone than rebuilding from the already validated layout for this small settings change. A rebuild is consistent with the dashboard’s existing breakpoint/provider rebuild model.

## Data flow

1. Settings checkbox emits `settings:update` with a boolean.
2. Main process persists the key and broadcasts `settings:loaded`.
3. Dashboard receives the new settings snapshot.
4. The visibility helper computes the visible IDs.
5. A changed visibility signature increments the dashboard rebuild key.
6. The memoized GridStack children are regenerated from the unchanged layout, filtered by visibility and provider availability.

## Error handling

- Missing or malformed settings objects use registry defaults.
- A missing registry entry is treated as not visible.
- Subscription cleanup must remove the `settings:loaded` listener on unmount.
- Existing `getSettings()` failure behavior remains unchanged; the dashboard stays in its current loading/error path rather than inventing settings.

## Testing strategy

### Automated regression tests

- A pure helper test proves `components.tokenLine = false` excludes `token-line`.
- A second disabled module proves behavior is registry-driven rather than hard-coded.
- Missing values fall back to `defaultVisible`.
- Re-enabling restores the ID without mutating the layout fixture.
- Existing full `npm test` suite must pass.
- `npm run build:renderer` must complete successfully.

### Runtime verification

When an executable checkout is available:

1. Launch Electron.
2. Disable “Token 消耗趋势” and verify its DOM node disappears and neighboring modules reflow.
3. Re-enable it and verify the node returns with prior geometry.
4. Repeat for “费用增长趋势”.
5. Restart and verify persistence.
6. Capture before/after screenshots.

Runtime screenshots are supporting evidence, not a replacement for the automated regression test.

## Acceptance criteria

- Component switches hide and show their matching modules immediately.
- The behavior applies to every registry-defined component.
- Settings persist across restart.
- Hiding does not delete saved geometry.
- Re-enabling restores the component from its previous layout record.
- Provider-backed quota visibility continues to depend on provider availability.
- Automated tests and renderer build pass before the Draft PR is created.
