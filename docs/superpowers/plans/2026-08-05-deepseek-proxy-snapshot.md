# DeepSeek Proxy Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure one DeepSeek usage polling operation uses one stable HTTP transport and proxy snapshot across current usage, fallback, and backfill requests.

**Architecture:** Capture `requestOptionsFor(ctx)` once at the start of `fetchUsage()` and pass the same object to `fetchUsageWithFallback()` and `backfillMonths()`. Keep each later polling operation independent so it reads the then-current proxy configuration.

**Tech Stack:** Node.js CommonJS, Provider adapter, Node test runner, GitHub Actions.

## Global Constraints

- No new runtime dependencies.
- Current-month cost/amount, previous-month fallback, and historical backfill share one options object per polling operation.
- A later polling operation reads the latest proxy value.
- Direct mode, timeouts, authentication classification, and error propagation remain unchanged.

---

### Task 1: Establish RED

**Files:**
- Create: `test/deepseek-proxy-snapshot.test.js`

**Interfaces:**
- Consumes: `deepseekAdapter.fetchUsage(ctx, { month, year })`
- Produces: a failing test requiring one `getProxyUrl()` read and the same proxy value on current and backfill requests

- [ ] Add a store fixture with exactly one unfetched historical month.
- [ ] Record all shared `httpGet` calls and proxy values.
- [ ] Require one proxy read, current cost/amount plus one backfill request, and one proxy value for all calls.
- [ ] Run CI and confirm only the new proxy-read assertion fails.

### Task 2: Implement GREEN

**Files:**
- Modify: `src/main/providers/deepseek/index.js`
- Test: `test/deepseek-proxy-snapshot.test.js`

**Interfaces:**
- Produces: one immutable request-options snapshot per `fetchUsage()` invocation

- [ ] Evaluate `requestOptionsFor(ctx)` once after validating the session token.
- [ ] Pass that object unchanged to current/fallback usage and historical backfill.
- [ ] Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- [ ] Review the final diff, check review state, update the PR evidence, and squash merge using the verified head SHA.
