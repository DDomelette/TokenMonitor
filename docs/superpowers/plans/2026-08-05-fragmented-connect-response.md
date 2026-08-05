# Fragmented CONNECT Response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse HTTP CONNECT responses only after a complete bounded header is available and preserve any tunnel bytes received in the completing TCP chunk.

**Architecture:** Extend the existing `requestCore()` CONNECT stage with an incremental Buffer and named data handler. The handler retains the existing timeout and single-settlement ownership, pauses/removes itself after framing completes, pushes tunnel bytes back onto the socket, then starts the existing TLS stage.

**Tech Stack:** Node.js 22, `net`, `tls`, `https`, Node test runner, Electron CI smoke test.

## Global Constraints

- Modify only `DDomelette/TokenMonitor`.
- Scope is Issue #26 only.
- Use test-first RED/GREEN evidence.
- Limit the complete CONNECT response header to 32 KiB.
- Do not reset the CONNECT-response timeout on partial chunks.
- Do not expose proxy headers, credentials, or tunnel bytes in errors.
- Keep HTTPS-proxy transport and proxy authentication out of scope.

---

### Task 1: Add fragmented CONNECT behavior tests

**Files:**
- Create: `test/proxy-connect-fragmentation.test.js`
- Test: `test/proxy-connect-fragmentation.test.js`

**Interfaces:**
- Consumes: `httpGet(url, headers, proxyUrl, timeoutOptions)` from `src/main/core/http.js`.
- Produces: deterministic protocol-boundary tests using temporary replacements for `net.connect`, `tls.connect`, and `https.request`.

- [ ] **Step 1: Build a fake socket and successful HTTPS response harness**

The fake raw socket must implement `write()`, `pause()`, `unshift()`, `destroy()`, `destroyed`, and EventEmitter methods. The TLS stub must record when it starts and emit `secureConnect`; the HTTPS stub must emit a 200 JSON response.

- [ ] **Step 2: Write the failing split-header test**

Emit `connect`, then fragments such as:

```js
socket.emit('data', Buffer.from('HTTP/1.'));
socket.emit('data', Buffer.from('1 200 Connection Established\r\nProxy-Agent: test\r\n'));
socket.emit('data', Buffer.from('\r\n'));
```

Require TLS not to start before the third fragment and the request to resolve after it.

- [ ] **Step 3: Write the failing remainder-preservation test**

Complete the response with:

```js
Buffer.concat([
  Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'),
  Buffer.from([0x16, 0x03, 0x03, 0x00, 0x01])
])
```

Require `socket.pause()` before TLS and one `socket.unshift()` call containing exactly the five tunnel bytes.

- [ ] **Step 4: Write non-200 and oversized-header tests**

A fragmented `HTTP/1.1 407 Proxy Authentication Required` response must reject only after `\r\n\r\n`. A header larger than `32 * 1024` bytes without a terminator must reject with code `PROXY_CONNECT_HEADER_TOO_LARGE`, destroy the socket once, and never invoke TLS.

- [ ] **Step 5: Create a Draft PR and verify RED**

Run through GitHub Actions with only the test file added. Expected failures: the first fragment is immediately interpreted as the complete response; no remainder is unshifted; and no header-size error exists.

---

### Task 2: Implement bounded incremental CONNECT framing

**Files:**
- Modify: `src/main/core/http.js`
- Test: `test/proxy-connect-fragmentation.test.js`

**Interfaces:**
- Consumes: proxy socket `data` chunks and the existing CONNECT-response timer.
- Produces: complete header parsing, safe status errors, remainder handoff, and transition to the existing TLS stage.

- [ ] **Step 1: Add the header limit and safe status helper**

Add:

```js
const MAX_CONNECT_HEADER_BYTES = 32 * 1024;

function safeProxyStatusLine(line) {
  return String(line || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 200);
}
```

- [ ] **Step 2: Replace `once('data')` with a named incremental handler**

Maintain `let connectBuffer = Buffer.alloc(0)`. On each chunk, concatenate, find `\r\n\r\n`, and return without parsing while incomplete. Reject with `PROXY_CONNECT_HEADER_TOO_LARGE` when the incomplete buffer or completed header exceeds the limit.

- [ ] **Step 3: Parse the complete status line**

Extract the first CRLF-delimited line and match:

```js
/^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/i
```

Reject malformed or non-200 status with `proxy CONNECT failed: <safe line>` through `rejectOnce(error, true)`.

- [ ] **Step 4: Preserve tunnel bytes and start TLS**

On a successful 200 response:

```js
proxySocket.pause();
proxySocket.off('data', onConnectData);
if (remainder.length) proxySocket.unshift(remainder);
```

Then clear the CONNECT-response timer and start the existing TLS-handshake timer and `tls.connect()` path.

- [ ] **Step 5: Verify focused GREEN**

Run `node --test test/proxy-connect-fragmentation.test.js test/proxy-connect-timeout.test.js`. Expected: all fragmentation and timeout tests pass with zero failures.

- [ ] **Step 6: Verify the complete repository**

Run `npm test`, `npm run build:renderer`, and the Electron/Xvfb visibility smoke test in CI. Expected: zero test failures, successful renderer build, successful smoke test, and uploaded screenshots.

- [ ] **Step 7: Review and merge**

Review the final two production/test files plus these design documents, confirm zero unresolved review threads, update the PR with RED/GREEN evidence, mark ready, and squash merge using the verified head SHA.
