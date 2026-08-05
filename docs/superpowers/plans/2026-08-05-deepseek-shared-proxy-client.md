# DeepSeek Shared Proxy Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route DeepSeek balance and platform usage requests through the same proxy-aware HTTP client used by the other Providers.

**Architecture:** Keep DeepSeek response parsing inside its existing balance and usage modules, but remove their ownership of sockets and HTTPS requests. Both modules consume an injected `httpGet(url, headers, proxyUrl, timeoutOptions)` transport, defaulting to the shared main-process client for backward-compatible direct calls. The Provider adapter supplies `ctx.httpGet` and the current `ctx.getProxyUrl()` on every request, including historical backfill.

**Tech Stack:** Node.js CommonJS, Electron main process, `src/main/core/http.js`, Node test runner, local TCP CONNECT fixtures.

## Global Constraints

- No new runtime dependencies.
- Empty proxy values continue to mean direct HTTPS.
- Balance request timeout remains 10 seconds; usage request timeout remains 15 seconds.
- 401/403 remain recognizable authentication errors containing the HTTP status.
- Non-2xx responses reject and never trigger previous-month fallback.
- Existing balance and usage payload shapes remain unchanged.

---

### Task 1: Establish transport and proxy RED

**Files:**
- Create: `test/deepseek-proxy-client.test.js`
- Modify: none

**Interfaces:**
- Consumes: `fetchBalance(apiKey, options?)`, `UsageFetcher`, `src/main/core/http.js#httpGet`
- Produces: failing tests that require `{ httpGet, proxyUrl }` injection and Provider-context wiring

- [ ] **Step 1: Add injected-transport tests**

Require balance, current-month cost/amount, and historical amount backfill to call the supplied transport with the exact DeepSeek HTTPS URL, authorization header, configured proxy URL, and request timeout.

- [ ] **Step 2: Add real local CONNECT integration tests**

Run balance and usage requests against a local TCP proxy fixture while TLS and upstream response objects are deterministic test doubles. Assert the proxy receives `CONNECT api.deepseek.com:443` and `CONNECT platform.deepseek.com:443` respectively.

- [ ] **Step 3: Add direct and error-semantics tests**

Require an empty proxy to reach the shared transport as `null`, preserve recognizable 401/403 errors, reject non-2xx responses, and prevent `fetchUsageWithFallback()` from querying the previous month after a transport rejection.

- [ ] **Step 4: Add source guards**

Require `balance.js` and `usage.js` to stop importing `https`, and require `index.js` to pass both `ctx.httpGet` and `ctx.getProxyUrl()` to balance, current usage, and backfill calls.

- [ ] **Step 5: Run CI to verify RED**

Run: GitHub Actions `CI` on the Draft PR.
Expected: every pre-existing test passes; only the new transport/proxy/source tests fail.

---

### Task 2: Route balance through the shared client

**Files:**
- Modify: `src/main/providers/deepseek/balance.js`
- Test: `test/deepseek-proxy-client.test.js`

**Interfaces:**
- Consumes: `options.httpGet`, `options.proxyUrl`
- Produces: `fetchBalance(apiKey, options = {}) -> Promise<Balance|null>`

- [ ] **Step 1: Extract balance payload parsing**

Parse the already-decoded JSON into the existing `{ available, currency, total, granted, toppedUp }` shape and preserve `null` for a structurally valid response without balance data.

- [ ] **Step 2: Call the shared transport**

Use `options.httpGet || require('../../core/http').httpGet` with URL `https://api.deepseek.com/user/balance`, the existing headers, `options.proxyUrl || null`, and `{ requestTimeoutMs: 10000 }`.

- [ ] **Step 3: Preserve balance error meaning**

Keep 401/403 recognizable as invalid API-key authentication failures and keep parse failures identifiable as balance-response parsing failures without exposing response bodies.

- [ ] **Step 4: Run focused tests and commit**

Expected: balance injection, direct-mode, CONNECT, and error tests pass.

---

### Task 3: Route usage and backfill through the shared client

**Files:**
- Modify: `src/main/providers/deepseek/usage.js`
- Modify: `src/main/providers/deepseek/index.js`
- Test: `test/deepseek-proxy-client.test.js`

**Interfaces:**
- Consumes: request options `{ httpGet, proxyUrl }`
- Produces: unchanged `fetchUsageCost`, `fetchUsageAmount`, and `fetchUsageWithFallback` result shapes

- [ ] **Step 1: Replace `UsageFetcher.httpGet` socket ownership**

Build the full platform URL and call the injected or default shared `httpGet` with the existing bearer and app-version headers, configured proxy, and `{ requestTimeoutMs: 15000 }`.

- [ ] **Step 2: Thread options through every usage method**

Add an optional request-options argument to cost, amount, and fallback methods. Pass it unchanged to current-month and previous-month calls.

- [ ] **Step 3: Wire Provider context for all network paths**

In `index.js`, construct request options from the live `ctx.httpGet` and `ctx.getProxyUrl()`. Use the same options for balance, current usage, previous-month fallback, and every historical backfill month.

- [ ] **Step 4: Preserve fallback and error semantics**

Only a successful current-month response with zero totals may trigger previous-month fallback. A rejected request propagates immediately and is not converted into empty data.

- [ ] **Step 5: Run the complete suite and commit**

Expected: all proxy, direct, auth, non-2xx, fallback, adapter, and legacy parser tests pass.

---

### Task 4: Final verification and merge

**Files:**
- Modify: PR description only

**Interfaces:**
- Consumes: fixed PR head SHA and CI evidence
- Produces: merged PR closing Issue #23

- [ ] **Step 1: Run complete CI**

Require the full Node test suite, renderer production build, Electron/Xvfb visibility smoke test, and screenshot artifact upload to pass on one fixed head.

- [ ] **Step 2: Review the final diff**

Confirm no direct `https.request` remains in DeepSeek balance/usage, no credential is logged, request timeouts remain 10/15 seconds, and every network path receives the live proxy setting.

- [ ] **Step 3: Check review state**

Require zero unresolved review threads and inspect all PR reviews and comments.

- [ ] **Step 4: Update and merge**

Record RED/GREEN evidence in the PR, mark ready, and squash merge using `expected_head_sha`.
