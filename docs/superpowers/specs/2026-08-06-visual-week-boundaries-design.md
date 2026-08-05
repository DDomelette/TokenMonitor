# Visual Week Boundaries Design

## Goal

Make TokenHeatmap weekly totals match the Sunday-to-Saturday columns already rendered by `buildWeeks()`.

## Chosen semantics

Each weekly bucket is keyed by the local calendar date of the Sunday that starts the rendered column. Sunday through Saturday share that key. A cross-year column belongs to its actual starting Sunday, even when that date is in the previous year; only daily records returned for the selected year contribute to that column.

Month labels remain tied to the column containing each month's first day. The daily and cumulative modes, visible-range logic, provider filtering, tooltip delay, and heatmap API remain unchanged.

## Implementation boundary

- Add pure `sundayWeekKey(date)` and `buildSundayWeekTotals(days)` helpers in `renderer/src/lib/heatmap.js`.
- Replace ISO-week aggregation in `TokenHeatmap.jsx` with those helpers.
- Use each rendered column's first cell date as the weekly key for color and tooltip totals.
- Remove the component's dependency on `isoWeekKey`; retaining the exported legacy helper is unnecessary unless another caller exists.

## Tests

- Sunday and the following Monday map to the same visual week.
- Sunday-only and Monday-only usage appear in the correct columns.
- The first 2026 column is keyed by Sunday 2025-12-28 while summing only 2026 data.
- Every weekly total equals the sum of the seven daily cells rendered in that column.
- Component source uses visual-week helpers and no ISO-week aggregation.
