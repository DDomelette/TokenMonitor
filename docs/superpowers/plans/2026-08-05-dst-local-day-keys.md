# DST-Safe Local Day Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group every local-log record by the local calendar date at the record's own timestamp, independent of the offset in effect when the scan runs.

**Architecture:** Replace the scan-time offset conversion in `localDayStr()` with local year/month/day extraction from `new Date(tsMs)`. Preserve `localTzSec()` as a compatible helper, but let it accept an optional timestamp and derive the offset at that instant.

**Tech Stack:** Node.js CommonJS, fixed `TZ` subprocess tests, Node test runner, GitHub Actions.

## Global Constraints

- No runtime dependencies.
- Historical records use the timezone offset applicable at their own timestamp.
- Spring and autumn DST boundaries remain on the correct local calendar date.
- Non-DST timezones retain existing behavior.
- Daily rollup keys and usage totals remain unchanged apart from corrected dates.

---

### Task 1: Establish RED

**Files:**
- Create: `test/locallog-dst-day-key.test.js`

**Interfaces:**
- Consumes: `localDayStr(tsMs)`, `localTzSec(tsMs)`, and `rollupDaily(records, diagnostics, nowMs)`
- Produces: fixed-timezone failures showing scan-time offset contamination

- [ ] Simulate a winter scan grouping a summer New York 00:30 record.
- [ ] Simulate a summer scan grouping a winter New York 23:30 record.
- [ ] Verify records immediately before and after both DST transitions keep their local date.
- [ ] Verify Asia/Singapore behavior is unchanged.
- [ ] Require rollup keys to use the same corrected date function.
- [ ] Run CI and confirm only the new DST contract fails.

### Task 2: Implement GREEN

**Files:**
- Modify: `src/main/core/locallog.js`
- Test: `test/locallog-dst-day-key.test.js`

**Interfaces:**
- Produces: `localDayStr(tsMs)` based on target-date local fields
- Produces: `localTzSec(tsMs = Date.now())` based on the requested instant

- [ ] Add a two-digit local date formatter.
- [ ] Build `YYYY-MM-DD` from target-date local year, month, and day.
- [ ] Make `localTzSec()` derive its offset from the supplied timestamp.
- [ ] Run the complete test suite, renderer build, and Electron/Xvfb smoke test.
- [ ] Review the fixed-head diff, verify review state, update PR evidence, and squash merge using the verified head SHA.
