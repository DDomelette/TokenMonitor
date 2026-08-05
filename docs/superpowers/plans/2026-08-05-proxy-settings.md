# Explicit Proxy Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Provide direct, system, and custom HTTP proxy settings without forcing a localhost proxy on new installations.

**Architecture:** Keep `providers.proxyUrl` as the compatible stored representation (`''`, `'system'`, or normalized HTTP URL). Centralize validation and Electron system-proxy interpretation in a pure main-process module. Allow the shared HTTP client to resolve target-aware asynchronous proxy inputs while preserving existing string/null behavior. Add a dedicated settings control that writes through the acknowledged, authoritative settings boundary.

**Tech Stack:** Electron session proxy resolver, Node.js CommonJS, plain renderer JavaScript, Node test runner.

---

### Task 1: Establish RED for proxy policy and persistence

**Files:**
- Create: `test/proxy-settings-policy.test.js`
- Create: `test/proxy-settings-integration.test.js`
- Modify: none

- [x] Test direct, system, and normalized custom stored values.
- [x] Test invalid schemes, credentials, paths, query strings, fragments, and ports.
- [x] Test `DIRECT` and `PROXY` system directives and rejection of unsupported directives.
- [x] Test invalid settings are rejected before store mutation, side effects, or broadcast.
- [x] Test the new-install default is direct.
- [x] Test settings definitions and renderer controls expose mode, address, Apply, and inline feedback.
- [x] Create a Draft PR and record the expected RED result.

### Task 2: Implement authoritative proxy policy

**Files:**
- Create: `src/main/core/proxy-settings.js`
- Modify: `src/main/store.js`
- Modify: `src/main/core/settings-write.js`
- Test: `test/proxy-settings-policy.test.js`
- Test: `test/proxy-settings-integration.test.js`

- [x] Implement strict custom HTTP proxy normalization.
- [x] Implement stored-value classification and validation.
- [x] Parse Electron system-proxy directives into direct or HTTP CONNECT proxy values.
- [x] Implement a live store-backed proxy-input getter for isolated policy consumers and tests.
- [x] Change the new-install default from localhost:7890 to direct.
- [x] Normalize and validate every `providers.proxyUrl` write before persistence.

### Task 3: Integrate target-aware system proxy resolution

**Files:**
- Modify: `src/main/core/http.js`
- Modify: `src/main/core/scheduler.js`
- Modify: `src/main/providers/deepseek/balance.js`
- Create: `test/http-proxy-resolver.test.js`
- Test: `test/proxy-settings-integration.test.js`

- [x] Allow the shared HTTP client to accept a proxy resolver function or promise.
- [x] Invoke resolver functions with the actual target URL before parsing the proxy.
- [x] Resolve the stored system sentinel at the scheduler network boundary for every Provider.
- [x] Resolve the same sentinel at the DeepSeek balance boundary used by API-key verification.
- [x] Call `session.defaultSession.resolveProxy(targetUrl)` lazily through the centralized policy module.
- [x] Preserve all existing direct/custom proxy behavior and timeout/error semantics.

### Task 4: Add settings-window controls

**Files:**
- Modify: `src/renderer/js/settings-definitions.js`
- Modify: `src/renderer/js/settings-window.js`
- Test: `test/proxy-settings-integration.test.js`

- [x] Add the Network group and dedicated proxy control definition.
- [x] Derive Direct/System/Custom mode from the stored value.
- [x] Enable the address input only for Custom mode.
- [x] Submit canonical candidates through `settings:save`.
- [x] Show inline success and validation-error feedback.
- [x] Ensure generic debounce handlers never save intermediate proxy text.

### Task 5: Final verification and merge

**Files:**
- Modify: PR description only

- [ ] Run the complete Node test suite on the final documentation-aligned head.
- [ ] Run the renderer production build.
- [ ] Run the Electron/Xvfb visibility smoke and upload screenshots.
- [ ] Review the fixed-head diff for proxy bypasses, unsafe PAC text, and unintended migration behavior.
- [ ] Require zero unresolved review threads and inspect all reviews/comments.
- [ ] Update TDD evidence, mark ready, and squash merge using the verified head SHA.
