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

- [ ] Test direct, system, and normalized custom stored values.
- [ ] Test invalid schemes, credentials, paths, query strings, fragments, and ports.
- [ ] Test `DIRECT` and `PROXY` system directives and rejection of unsupported directives.
- [ ] Test invalid settings are rejected before store mutation, side effects, or broadcast.
- [ ] Test the new-install default is direct.
- [ ] Test settings definitions and renderer controls expose mode, address, Apply, and inline feedback.
- [ ] Create a Draft PR and record the expected RED result.

### Task 2: Implement authoritative proxy policy

**Files:**
- Create: `src/main/core/proxy-settings.js`
- Modify: `src/main/store.js`
- Modify: `src/main/core/settings-write.js`
- Test: `test/proxy-settings-policy.test.js`
- Test: `test/proxy-settings-integration.test.js`

- [ ] Implement strict custom HTTP proxy normalization.
- [ ] Implement stored-value classification and validation.
- [ ] Parse Electron system-proxy directives into direct or HTTP CONNECT proxy values.
- [ ] Implement a live store-backed proxy-input getter.
- [ ] Change the new-install default from localhost:7890 to direct.
- [ ] Normalize and validate every `providers.proxyUrl` write before persistence.

### Task 3: Integrate target-aware system proxy resolution

**Files:**
- Modify: `src/main/core/http.js`
- Modify: `src/main/core/scheduler.js`
- Modify: `src/main/index.js`
- Modify: `src/main/ipc.js`
- Create: `test/http-proxy-resolver.test.js`
- Test: `test/proxy-settings-integration.test.js`

- [ ] Allow the shared HTTP client to accept a proxy resolver function or promise.
- [ ] Invoke resolver functions with the actual target URL before parsing the proxy.
- [ ] Inject one live proxy-input getter into the scheduler and IPC verification contexts.
- [ ] Resolve system policy through `session.defaultSession.resolveProxy(targetUrl)`.
- [ ] Preserve all existing direct/custom proxy behavior and timeout/error semantics.

### Task 4: Add settings-window controls

**Files:**
- Modify: `src/renderer/js/settings-definitions.js`
- Modify: `src/renderer/js/settings-window.js`
- Test: `test/proxy-settings-integration.test.js`

- [ ] Add the Network group and dedicated proxy control definition.
- [ ] Derive Direct/System/Custom mode from the stored value.
- [ ] Enable the address input only for Custom mode.
- [ ] Submit canonical candidates through `settings:save`.
- [ ] Show inline success and validation-error feedback.
- [ ] Ensure generic debounce handlers never save intermediate proxy text.

### Task 5: Final verification and merge

**Files:**
- Modify: PR description only

- [ ] Run the complete Node test suite.
- [ ] Run the renderer production build.
- [ ] Run the Electron/Xvfb visibility smoke and upload screenshots.
- [ ] Review the fixed-head diff for proxy bypasses, unsafe PAC text, and unintended migration behavior.
- [ ] Require zero unresolved review threads and inspect all reviews/comments.
- [ ] Update TDD evidence, mark ready, and squash merge using the verified head SHA.
