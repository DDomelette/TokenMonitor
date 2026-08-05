# Session Expiry State Implementation Plan

**Goal:** Make DeepSeek platform session validity consistent across the scheduler, settings window, IPC snapshots, persisted credentials, and tray menu.

**Architecture:** Add a small pure session-state boundary that owns the `missing`, `valid`, and `expired` transitions for the existing runtime object. The main process will use the boundary for startup restoration, successful token capture, authentication expiry, snapshots, and tray labels. Expiry clears the invalid in-memory and persisted token so later polls and restarts cannot continue treating it as usable. The settings window keeps consuming the existing `{ loggedIn, error }` payload and therefore displays the explicit expiry error whenever validity is false.

## Task 1: Establish RED

- Add state-machine tests for valid → expired → valid.
- Require expiry to invalidate a stale token and expose an explicit error.
- Require tray labels for missing, expired, and valid states.
- Add source integration guards for scheduler expiry, persisted-token deletion, successful capture/startup restoration, IPC snapshots, and settings error precedence.
- Create a Draft PR and record RED while all existing tests remain green.

## Task 2: Implement GREEN

- Add `src/main/core/session-state.js`.
- Initialize runtime with an explicit session status/error.
- Use the state boundary in `broadcastSessionState()`, `get:session-state`, `updateTrayMenu()`, successful capture, startup restoration, aborted login, and scheduler expiry.
- Delete `providers.deepseek.sessionToken` when a protected request proves it invalid.
- Preserve existing session capture, poll scheduling, and renderer IPC channels.
- Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- Review the final diff, confirm zero unresolved review threads, update PR evidence, mark ready, and squash merge using the verified head SHA.

## Semantics and scope

A non-empty token is not sufficient to be logged in: only `status === 'valid'` is valid. Authentication expiry is terminal for that token and requires a newly captured token. This issue does not change DeepSeek API-key authentication, automatically reopen the login window, or alter generic provider auth-state behavior.
