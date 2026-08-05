# Poll Error Broadcast Implementation Plan

**Goal:** Broadcast non-authentication polling failures without discarding the last successful data, deduplicate repeated failures, and make the renderer show that retained data may be stale.

**Architecture:** Keep private per-channel error records inside each scheduler provider state. Derive one public latest-error summary with its channel, failure time, last successful fetch time, and a `stale` flag. A visible state transition broadcasts exactly once; an identical repeated error on the same channel does not. A successful poll clears only that channel's error and broadcasts the recovered state. The status bar consumes the server timestamps instead of treating every provider broadcast as a successful refresh.

## Task 1: Establish RED

- Add timeout-after-success coverage that preserves quota data and broadcasts `stale: true`.
- Add repeated-identical-error coverage requiring zero additional broadcasts.
- Add HTTP 5xx and proxy-failure coverage on separate polling channels.
- Add recovery coverage requiring the corresponding error to clear on success.
- Add a pure renderer health-summary test and a source guard preventing error broadcasts from resetting the refresh clock.
- Create a Draft PR and record RED while all existing tests remain green.

## Task 2: Implement GREEN

- Add channel-aware error bookkeeping to `src/main/core/scheduler.js`.
- Make balance, usage, quota, and local-log failures use one transition path.
- Expose `lastErrorChannel`, `lastFailedAt`, `lastFetchedAt`, and `stale` in provider snapshots.
- Add `renderer/src/provider-health.mjs` and make `StatusBar` use the provider snapshot's success timestamp.
- Add a warning status-dot state for stale retained data.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Semantics and scope

A failed poll preserves the prior payload. `stale` is true only when a failure exists after at least one successful provider fetch. Identical messages on the same channel are deduplicated until that channel succeeds or reports a different error. This issue does not add retries, change polling intervals, or replace provider-specific authorization handling.
