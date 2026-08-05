# Local Yesterday Cost Implementation Plan

**Goal:** Make the “昨日” amount use the user's local calendar day instead of UTC date ordering.

**Architecture:** Extract local date-key and yesterday-cost logic from `FeeCard.jsx` into a pure renderer helper. The helper derives `YYYY-MM-DD` from local calendar fields, subtracts one local calendar day, and looks up that exact date. It never depends on a current-day row and never falls back to the most recent historical entry.

## Task 1: Establish RED

- Add isolated timezone tests for UTC+8 local midnight, a UTC- timezone, and a cross-year boundary.
- Require exact yesterday lookup even when today's row is absent.
- Require zero when the exact yesterday row is absent, regardless of other historical rows.
- Add a source guard requiring `FeeCard.jsx` to use the shared helper and remove UTC `toISOString()` date derivation.
- Create a Draft PR and record RED while all existing tests remain green.

## Task 2: Implement GREEN

- Add a pure `fee-card-date.mjs` helper for local date keys and exact yesterday cost lookup.
- Import the helper from `FeeCard.jsx` and remove its inline UTC/order-based implementation.
- Keep card rendering and monetary formatting unchanged.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Semantics and scope

“Yesterday” is the local calendar date immediately preceding the current local date. A missing today row is irrelevant. A missing exact yesterday row yields zero. This issue does not alter DeepSeek usage collection, today metrics, currency formatting, or historical chart data.
