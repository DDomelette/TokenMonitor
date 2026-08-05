# Initial Provider Health Implementation Plan

**Goal:** Prevent the status bar from reporting an online connection before any provider has completed a successful data request.

**Architecture:** Extend the existing pure provider-health summary with two pre-success states. An empty snapshot or a snapshot containing at least one potentially usable provider remains `loading` until a `lastFetchedAt` exists or an error arrives. A non-empty snapshot where every provider is `authStatus: missing` becomes `missing`. Existing error, stale, and online precedence stays unchanged, and the status bar continues using only provider snapshots.

## Task 1: Establish RED

- Add an empty-snapshot loading test.
- Add an all-missing credentials test.
- Add a mixed missing/available initial snapshot test.
- Require an offline/network failure to remain distinct from loading and missing.
- Require no initial state without `lastFetchedAt` to be online.
- Add source/style guards for distinct loading and missing status dots.
- Create a Draft PR and record RED while all existing tests remain green.

## Task 2: Implement GREEN

- Update `renderer/src/provider-health.mjs` with loading and missing classifications after existing failure/success precedence.
- Add final loading and missing status-dot styles to `provider-health.css`.
- Preserve stale/error aggregation and successful timestamp logic from Issue #15.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Semantics and scope

Only a finite positive `lastFetchedAt` proves that any data channel has succeeded. Credential presence is not success. This issue does not add a polling progress event, change provider authentication, or introduce retry behavior.
