# Runtime Provider Auth Recovery Implementation Plan

**Goal:** Keep provider authentication state synchronized with credentials that appear or disappear while Token Monitor is running.

**Architecture:** Re-evaluate each provider's `authStatus()` immediately before protected balance, usage, and quota polls. A definitive `missing` result updates and broadcasts the state while skipping the request, preserving the last successful payload. If credentials appear after a missing state, the request is attempted without optimistically marking the provider healthy; only a successful protected response transitions `missing` or `expired` to `ok`. Local-log collection remains independent of provider authentication.

## Task 1: Establish RED

- Add a temporary credential-file lifecycle test: missing at startup, created while running, successful quota fetch, then deleted while running.
- Require the first successful protected request to broadcast `authStatus: ok` and retain the returned quota.
- Require credential deletion to broadcast `authStatus: missing`, skip the protected request, and preserve the prior quota and successful timestamp.
- Parameterize balance, usage, and quota success from `missing` and `expired` states.
- Create a Draft PR and record RED while all existing tests remain green.

## Task 2: Implement GREEN

- Add one protected-poll authentication preflight in `src/main/core/scheduler.js`.
- Make a preflight `missing` result update state once and skip the request.
- Make every protected request success set `authStatus: ok` before broadcasting.
- Preserve channel-error deduplication, stale data, local-log behavior, and existing provider adapters.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Semantics and scope

Credentials becoming present is not sufficient to report healthy: the provider becomes `ok` only after a protected request succeeds. Credentials becoming absent is authoritative and immediately returns the provider to `missing`. This issue does not add file watchers, alter credential refresh implementations, or treat local-log success as authentication proof.
