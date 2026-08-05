# Invalid Local Log Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent malformed or implausible local-log timestamps from contaminating the current day's token totals, while exposing a skipped-record diagnostic count.

**Architecture:** Define one timestamp validity policy in `src/main/core/locallog.js`: finite integer epoch milliseconds from 2000-01-01 through 24 hours after the evaluation time. Codex and Kimi parsers reject invalid timestamps and increment an optional diagnostics object. `rollupDaily()` independently applies the same policy so direct or future parser callers cannot reintroduce the current-time fallback.

**Tech Stack:** Node.js CommonJS, synchronous JSONL scanner, Node test runner, GitHub Actions.

## Global Constraints

- No runtime dependencies.
- Missing, zero, NaN, non-integer, pre-2000, and more-than-24-hours-future timestamps are invalid.
- Invalid timestamps never fall back to `Date.now()`.
- Complete invalid lines are consumed once; the cursor must not replay them on the next scan.
- Existing valid Codex/Kimi records and daily aggregation shapes remain unchanged.
- Diagnostic counting is opt-in through a caller-provided mutable object and must not affect production output shapes.

---

### Task 1: Establish RED

**Files:**
- Create: `test/locallog-invalid-timestamp.test.js`

**Interfaces:**
- Consumes: `parseRolloutLine(line, diagnostics, nowMs)`, `parseWireLine(line, diagnostics, nowMs)`, `rollupDaily(records, diagnostics, nowMs)`, and `readLocalLog(ctx, opts)`
- Produces: failing tests for parser rejection, rollup defense, skipped-count diagnostics, and one-time cursor consumption

- [ ] Test Kimi records with missing, zero, non-numeric, pre-2000, and excessive-future timestamps.
- [ ] Test the equivalent Codex timestamp cases while preserving a valid ISO timestamp.
- [ ] Pass invalid records directly to `rollupDaily()` and require only the valid record to aggregate.
- [ ] Scan a mixed Kimi file, require one valid record, five diagnostic skips, and no replay on a second scan.
- [ ] Run CI and confirm only the new timestamp-contract tests fail.

### Task 2: Implement GREEN

**Files:**
- Modify: `src/main/core/locallog.js`
- Modify: `src/main/providers/codex/locallog.js`
- Modify: `src/main/providers/kimi/locallog.js`
- Test: `test/locallog-invalid-timestamp.test.js`

**Interfaces:**
- Produces: `normalizeTimestampMs(value, nowMs)` returning a valid epoch millisecond integer or `null`
- Produces: optional diagnostics key `invalidTimestamp`

- [ ] Add shared timestamp constants, validation, and diagnostic increment helpers.
- [ ] Pass diagnostics and one evaluation time from `scanFiles()` into each parser invocation.
- [ ] Reject invalid timestamps in both provider parsers before returning a usage record.
- [ ] Remove the `Date.now()` fallback from `rollupDaily()` and skip invalid direct inputs.
- [ ] Thread optional diagnostics and evaluation time through both provider `readLocalLog()` functions.
- [ ] Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- [ ] Review the fixed-head diff, verify review state, update PR evidence, and squash merge using the verified head SHA.
