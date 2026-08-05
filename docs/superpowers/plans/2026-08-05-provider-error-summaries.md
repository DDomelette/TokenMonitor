# Safe Provider Error Summaries Implementation Plan

**Goal:** Show actionable provider failures in the status bar without treating partial failure as a global outage or exposing sensitive error details.

**Architecture:** Add one main-process error summarizer that maps common authentication, timeout, proxy, network, DNS, and HTTP failures to bounded user-safe text before scheduler state is stored or broadcast. Extend the existing renderer provider-health reducer so a healthy provider plus any failed provider becomes `degraded`, while complete failure remains `error` or `stale`. The renderer consumes only the already-sanitized snapshot and keeps the latest global success timestamp.

## Task 1: Establish RED

- Add pure sanitizer tests for HTTP response bodies, bearer/API tokens, URL query parameters, filesystem paths, timeouts, proxy failures, and bounded generic messages.
- Add scheduler integration coverage proving a secret-bearing provider exception cannot enter `lastError`.
- Add single-source complete-failure status coverage.
- Add multi-provider partial-failure coverage requiring `degraded`, `running: true`, and the healthy provider's success timestamp.
- Add degraded status-dot style coverage.
- Create a Draft PR and record RED while all existing tests remain green.

## Task 2: Implement GREEN

- Add `src/main/core/provider-error-summary.js`.
- Replace raw scheduler `error.message` storage with the safe summary while retaining raw authentication classification internally.
- Extend `renderer/src/provider-health.mjs` with healthy-provider detection and degraded precedence.
- Add a final degraded status-dot style.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Semantics and scope

Error summaries must be actionable categories, not server response dumps. Partial failure means at least one provider has a successful timestamp and no current error while at least one other provider has an error. Missing credentials alone are not a failure. This issue does not add retry logic, alter provider authentication transitions, or expose raw errors through another IPC channel.
