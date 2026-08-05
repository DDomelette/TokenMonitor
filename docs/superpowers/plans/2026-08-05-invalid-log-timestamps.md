# Invalid Local-Log Timestamp Implementation Plan

**Goal:** Prevent malformed local-log timestamps from being silently assigned to the scan day.

**Architecture:** Add one shared timestamp validator in the local-log core. Provider parsers reject otherwise-valid usage records whose timestamp is missing, non-finite, non-positive, before 2000-01-01, or more than 24 hours in the future. `rollupDaily()` independently rejects invalid records and optionally increments the same diagnostic counter. Provider read results remain arrays and expose a non-enumerable `diagnostics.skippedInvalidTimestamps` field.

## Task 1: Establish RED

- Add Kimi parser tests for missing, zero, NaN, ancient, and far-future timestamps.
- Add Codex parser tests for invalid ISO, ancient, and far-future timestamps.
- Require `rollupDaily()` to skip invalid records rather than use `Date.now()`.
- Require skipped records to be counted without changing the enumerable array contract.
- Require Kimi scanning to advance the cursor while excluding invalid usage from `usageDaily`.
- Create a Draft PR and record RED while all existing tests remain green.

## Task 2: Implement GREEN

- Add shared timestamp bounds, normalization, diagnostic increment, and diagnostic attachment helpers.
- Update Kimi and Codex parsers to use the shared validator.
- Update both local-log readers to pass parser diagnostics and attach them to returned records.
- Remove the `Date.now()` fallback from `rollupDaily()` and add defensive validation/counting.
- Preserve valid usage aggregation, cursor behavior, retention filtering, and provider payloads.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.

## Task 3: Final verification

- Review the fixed-head diff for accidental counting of irrelevant/non-usage lines.
- Confirm invalid lines are consumed exactly once and never enter `usageDaily`.
- Confirm zero unresolved review threads and inspect all reviews/comments.
- Update PR evidence, mark ready, and squash merge using the verified head SHA.
