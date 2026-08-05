# Async Chunked Local-Log Scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan large local JSONL logs asynchronously in bounded chunks without changing parsing, aggregation, or cursor correctness.

**Architecture:** Convert the core scanner and provider local-log entry points to Promise-based APIs. Use `fs.promises`, 64 KiB raw Buffer reads, a 4 MiB per-invocation byte budget, newline-delimited cursor commits, and an event-loop yield after each block.

**Tech Stack:** Node.js CommonJS, `fs.promises`, Buffer byte scanning, Electron scheduler, Node test runner, GitHub Actions.

## Global Constraints

- No new runtime dependencies or worker threads.
- Never allocate a Buffer based on the entire unread file tail.
- Default read block: 64 KiB.
- Default total read budget per scan: 4 MiB.
- Cursor advances only through complete newline-terminated lines.
- UTF-8 and partial JSON lines remain byte-exact across block boundaries.
- Existing Provider output, retention, diagnostics, migration, and scheduler error behavior remain unchanged.

---

### Task 1: Establish asynchronous chunking RED

**Files:**
- Create: `test/locallog-chunked-scan.test.js`
- Modify: `test/locallog.test.js`
- Modify: `test/locallog-invalid-timestamp.test.js`
- Modify: `test/locallog-stable-evaluation-time.test.js`

**Interfaces:**
- Consumes: `scanFiles(options)`, Codex/Kimi `readLocalLog(ctx, opts)`
- Produces: Promise-based tests for chunk bounds, budget continuation, cross-block UTF-8, partial-line safety, and event-loop yielding

- [ ] Add a guarded `fs.promises.open` fixture that records every read length and rejects requests above the configured chunk size.
- [ ] Write a multi-block JSONL file and require a small scan budget to consume it over multiple invocations without duplicates.
- [ ] Split Chinese UTF-8 content and a valid JSON record across small block boundaries and require exact parsing.
- [ ] End a scan budget inside a partial line, require no cursor advance past the previous newline, append the remainder, and require one later parse.
- [ ] Schedule a `setImmediate` callback and require it to run before a multi-block scan resolves.
- [ ] Convert existing direct scanner/provider tests to `async`/`await` without changing assertions.
- [ ] Create a Draft PR and record RED while the existing suite remains green.

### Task 2: Implement the async core scanner

**Files:**
- Modify: `src/main/core/locallog.js`
- Test: `test/locallog-chunked-scan.test.js`

**Interfaces:**
- Produces: `scanFiles(options) -> Promise<UsageRecord[]>`
- Produces: `walkFiles(root, match) -> Promise<string[]>`
- Produces constants `DEFAULT_SCAN_CHUNK_BYTES` and `DEFAULT_SCAN_BUDGET_BYTES`

- [ ] Replace recursive `readdirSync` with deterministic async traversal.
- [ ] Normalize optional chunk/budget/yield controls to safe defaults.
- [ ] Read at most one fixed-size block at a time using a `FileHandle`.
- [ ] Locate newline bytes in raw Buffers, decode only complete line prefixes, and retain the incomplete suffix.
- [ ] Update the committed offset after each complete prefix and save only that offset.
- [ ] Stop when the global byte budget is exhausted and resume from the committed cursor on the next call.
- [ ] Yield after each block and close every file handle in `finally`.
- [ ] Preserve truncation, rotation, diagnostics, and stale-cursor cleanup.

### Task 3: Convert provider and test call chains

**Files:**
- Modify: `src/main/providers/codex/locallog.js`
- Modify: `src/main/providers/kimi/locallog.js`
- Modify: affected tests under `test/`

**Interfaces:**
- Produces: `readLocalLog(ctx, opts) -> Promise<UsageRecord[]>`
- Consumes: scheduler's existing `await provider.readLocalLog(...)`

- [ ] Make both provider entry points async and await `scanFiles()` before rollup/persistence.
- [ ] Preserve one evaluation-time snapshot per provider read.
- [ ] Preserve Kimi's one-time migration ordering before scanning.
- [ ] Update every direct provider caller in tests to await the Promise.
- [ ] Verify scheduler and manual refresh continue to await local-log completion and inflight release.

### Task 4: Full verification and branch completion

**Files:**
- Review all changed files

**Interfaces:**
- Produces: a fixed-head merge candidate for Issue #28

- [ ] Run the complete automated test suite.
- [ ] Run the renderer production build.
- [ ] Run the Electron/Xvfb visibility smoke test and upload three screenshots.
- [ ] Review the final diff for bounded allocations, cursor safety, handle cleanup, event-loop yielding, and API compatibility.
- [ ] Verify zero unresolved review threads and actionable comments.
- [ ] Update PR RED/GREEN evidence, mark ready, and squash merge using the verified head SHA.
