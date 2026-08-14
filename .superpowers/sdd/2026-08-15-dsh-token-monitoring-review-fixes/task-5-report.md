# Task 5 Report: Host-timezone-independent curve merging

## Status

Implemented Beijing-day curve merging and UTC-midnight output timestamps.

## Files changed

- `renderer/src/lib/curve-merge.js`
- `test/curve-merge.test.js`

## TDD evidence

### RED

After changing the test fixture to `Date.UTC` and adding the Los Angeles regression, `node --test test/curve-merge.test.js` failed as intended:

- `mergeCurves keeps Beijing day keys stable on a UTC-minus host` produced host-local timestamps (`1786604400000`, `1786690800000`) instead of UTC-midnight timestamps (`1786665600000`, `1786752000000`).
- The existing same-day assertion also exposed the same local-midnight output defect after the fixture became timezone-independent.

The failure was caused by `localDayKey` using local date getters and output timestamps using `new Date(y, m - 1, d)`.

### GREEN

`node --test test/curve-merge.test.js test/beijing-calendar.test.js`

- 14 passed, 0 failed, 0 skipped.

## Build and full-suite evidence

- `npm run build:renderer`: passed; Vite transformed 638 modules. It emitted the existing chunk-size warning for a minified chunk over 500 kB.
- `npm test`: 798 passed, 0 failed, 1 skipped (799 total).

## Timezone and output invariants

- Each finite epoch input time is assigned through the existing `beijingDayKey` helper, so day grouping is fixed to UTC+8 Beijing days rather than the host timezone.
- Each merged point uses `Date.UTC(year, month - 1, day)`, so its output timestamp is UTC midnight for the Beijing day and independent of host timezone.
- Delta summing, chronological sort, cumulative totals, invalid-time skipping, and exports remain unchanged.

## Self-review

- `git diff --check` completed without whitespace errors.
- Reviewed the focused diff for `renderer/src/lib/curve-merge.js` and `test/curve-merge.test.js`.
- Confirmed `curve-merge.js` contains no host-local date getters (`getFullYear`, `getMonth`, `getDate`) or `new Date(...)` construction.

## Concerns

None. The renderer build's chunk-size warning was pre-existing/non-blocking and outside this task's scope.
