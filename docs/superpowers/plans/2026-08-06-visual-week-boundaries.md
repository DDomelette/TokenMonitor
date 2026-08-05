# Visual Week Boundaries Implementation Plan

**Goal:** Align weekly TokenHeatmap totals with the existing Sunday-to-Saturday visual columns.

## RED

- Extend `test/heatmap-cells.test.js` with visual-week helper, Sunday/Monday, cross-year, seven-cell sum, and component integration expectations.
- Create a Draft PR and record the expected failures while the existing suite remains green.

## GREEN

- Add `sundayWeekKey()` and `buildSundayWeekTotals()` to `renderer/src/lib/heatmap.js`.
- Replace ISO-week aggregation and lookups in `TokenHeatmap.jsx` with the visual column key.
- Preserve daily/cumulative modes, provider selection, month labels, tooltips, and visible-range behavior.

## Verification

- Run the complete automated suite.
- Build the renderer.
- Run the Electron/Xvfb component-visibility smoke test and upload screenshots.
- Review the final diff and unresolved threads.
- Mark ready and squash merge using the verified head SHA.
