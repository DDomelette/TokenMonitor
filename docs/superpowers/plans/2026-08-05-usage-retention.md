# Usage Retention Implementation Plan

**Goal:** Make `data.historyDays` physically remove expired daily usage and prevent all collectors from reintroducing records outside the configured local-calendar window.

**Architecture:** Add one pure retention boundary for local-day calculation, 3/7/30-day cutoff evaluation, immutable filtering, and store cleanup. A retention run mutates only `usageDaily`; DeepSeek fetched-month markers and Codex/Kimi file cursors remain untouched so destructive cleanup is not undone by historical backfill or a full log rescan. The DeepSeek writer and both local-log writers filter incoming daily records before merge, the heatmap reads a defensively filtered snapshot, and `data.historyDays` changes plus application startup invoke the same cleanup.

## Task 1: Establish RED

- Create `test/usage-retention.test.js`.
- Require the missing `src/main/core/usage-retention.js` module.
- Test inclusive 3/7/30-day local-calendar boundaries with a fixed midday timestamp.
- Test immutable filtering of old and future daily keys.
- Test physical store cleanup while preserving DeepSeek `fetchedMonths` and local-log cursors byte-for-byte.
- Test that an expired incoming daily record is filtered after cleanup and cannot reappear.
- Add source integration guards for Codex, Kimi, DeepSeek, heatmap, `data.historyDays` side effects, and startup cleanup ordering.
- Create a Draft PR and record expected RED while all existing tests remain green.

## Task 2: Implement GREEN

- Create `src/main/core/usage-retention.js`.
- Filter daily rollups before Codex/Kimi merge while retaining their advanced cursors.
- Filter DeepSeek daily persistence while retaining fetched-month markers.
- Prune immediately when `data.historyDays` changes.
- Prune once at startup before the scheduler begins collecting.
- Defensively filter the heatmap input without mutating the store.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Semantics and scope

`historyDays = N` retains today plus the preceding `N - 1` local calendar dates, inclusive. Cleanup is destructive: increasing the retention period later does not reset local-log cursors or DeepSeek month markers to recover already deleted history. This issue does not delete source log files, change collector schedules, change month backfill depth, or introduce archival storage.